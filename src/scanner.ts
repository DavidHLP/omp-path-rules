import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseFrontmatter } from "./frontmatter.js";
import type { ParsedRule, RuleKind, RuleRegistryState } from "./types.js";

export class RuleScanner {
  private cache: Map<string, ParsedRule> = new Map();

  /**
   * Clears the signature cache to force full re-scan.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Discovers and refreshes rules from project and global directories using signature cache invalidation.
   */
  async scan(
    cwd: string,
    logger?: { warn(msg: string): void }
  ): Promise<ParsedRule[]> {
    const projectDir = path.join(cwd, ".omp", "rules");
    const agentDir =
      process.env.PI_CODING_AGENT_DIR ||
      path.join(os.homedir(), ".omp", "agent");

    const homeRulesDir = path.join(os.homedir(), ".omp", "rules");
    const agentRulesDir = path.join(agentDir, "rules");

    // Scan global user directories first, then project (so project rules with same ID win)
    const homeGlobalFiles = await this.scanDirectory(homeRulesDir, "global", logger);
    const agentGlobalFiles = await this.scanDirectory(agentRulesDir, "global", logger);
    const projectFiles = await this.scanDirectory(projectDir, "project", logger);

    // Merge: index by rule ID
    const mergedById = new Map<string, ParsedRule>();
    for (const rule of homeGlobalFiles) {
      mergedById.set(rule.id, rule);
    }
    for (const rule of agentGlobalFiles) {
      mergedById.set(rule.id, rule);
    }
    for (const rule of projectFiles) {
      // Project rule overrides global rule of same ID
      mergedById.set(rule.id, rule);
    }

    return Array.from(mergedById.values());
  }

  /**
   * Scans a single rules directory with mtimeMs + size signature caching.
   */
  private async scanDirectory(
    dirPath: string,
    scope: "project" | "global",
    logger?: { warn(msg: string): void }
  ): Promise<ParsedRule[]> {
    const currentFiles = new Set<string>();
    const results: ParsedRule[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== ".md" && ext !== ".markdown") continue;

        const filePath = path.join(dirPath, entry.name);
        currentFiles.add(filePath);

        try {
          // Always read the file and validate the cache against a content
          // hash. An mtimeMs:size signature misses same-second, same-size
          // edits on coarse-mtime filesystems; content hashing cannot.
          const raw = await fs.readFile(filePath, "utf-8");
          const signature = createHash("sha256").update(raw).digest("hex");

          const cached = this.cache.get(filePath);
          if (cached && cached.rawSignature === signature) {
            results.push(cached);
            continue;
          }

          // Parse
          const { frontmatter, body } = parseFrontmatter(raw);

          const id = path.basename(entry.name, ext);
          const kind = this.classifyRule(frontmatter);
          const globs = this.normalizeGlobs(frontmatter);
          const priority =
            typeof frontmatter.priority === "number"
              ? frontmatter.priority
              : 100;

          const parsed: ParsedRule = {
            id,
            filePath,
            scope,
            kind,
            frontmatter,
            globs,
            priority,
            content: body,
            rawSignature: signature,
          };

          this.cache.set(filePath, parsed);
          results.push(parsed);
        } catch (fileErr) {
          logger?.warn(
            `[omp-path-rules] Failed to parse rule ${filePath}: ${
              fileErr instanceof Error ? fileErr.message : String(fileErr)
            }`
          );
        }
      }
    } catch {
      // Directory missing or unreadable -> fail-open gracefully
    }

    // Evict deleted files from cache for this directory
    for (const [cachedPath] of this.cache) {
      if (cachedPath.startsWith(dirPath) && !currentFiles.has(cachedPath)) {
        this.cache.delete(cachedPath);
      }
    }

    return results;
  }

  /**
   * Distinguishes TTSR Stream Rules, Native Always-Apply Rules, and Path Rules.
   * Matches OMP's native bucketRules behavior:
   * - TTSR requires an accepted, non-empty condition or astCondition (including legacy ttsr_trigger / ttsrTrigger).
   * - Scope alone without a trigger condition does not qualify as TTSR.
   */
  classifyRule(fm: Record<string, unknown>): RuleKind {
    // 1. Accepted TTSR stream rule
    if (this.hasTtsrTrigger(fm)) {
      return "ttsr_stream";
    }

    // 2. Native Always-Apply
    if (fm.alwaysApply === true) {
      return "always_apply";
    }

    // 3. Path Rule (Explicit globs or derived from scope without condition)
    if (
      (Array.isArray(fm.globs) && fm.globs.length > 0) ||
      (typeof fm.globs === "string" && fm.globs.trim().length > 0) ||
      fm.scope !== undefined
    ) {
      return "path_rule";
    }

    // 4. Default plain rulebook / documentation
    return "rulebook";
  }

  /**
   * Checks if frontmatter defines an active TTSR stream trigger condition.
   */
  private hasTtsrTrigger(fm: Record<string, unknown>): boolean {
    const hasCondition =
      (typeof fm.condition === "string" && fm.condition.trim().length > 0) ||
      (Array.isArray(fm.condition) && fm.condition.length > 0);

    const hasAstCondition =
      (typeof fm.astCondition === "string" && fm.astCondition.trim().length > 0) ||
      (Array.isArray(fm.astCondition) && fm.astCondition.length > 0) ||
      (typeof fm.ast_condition === "string" && fm.ast_condition.trim().length > 0) ||
      (Array.isArray(fm.ast_condition) && fm.ast_condition.length > 0);

    const hasTtsrTriggerField =
      (typeof fm.ttsr_trigger === "string" && fm.ttsr_trigger.trim().length > 0) ||
      (typeof fm.ttsrTrigger === "string" && fm.ttsrTrigger.trim().length > 0);

    return hasCondition || hasAstCondition || hasTtsrTriggerField;
  }

  /**
   * Extracts and normalizes glob patterns from frontmatter `globs` or tool `scope`.
   */
  private normalizeGlobs(fm: Record<string, unknown>): string[] {
    const globs: string[] = [];

    if (Array.isArray(fm.globs)) {
      for (const g of fm.globs) {
        if (typeof g === "string" && g.trim()) globs.push(g.trim());
      }
    } else if (typeof fm.globs === "string" && fm.globs.trim()) {
      globs.push(fm.globs.trim());
    }

    // Also support extracting path globs from scope like tool:edit(*.ts) or tool:write(src/**/*.tsx)
    if (fm.scope) {
      const scopes = Array.isArray(fm.scope) ? fm.scope : [fm.scope];
      for (const s of scopes) {
        if (typeof s !== "string") continue;
        const match = s.match(/tool:[a-zA-Z0-9_-]+\(([^)]+)\)/);
        if (match && match[1]) {
          globs.push(match[1].trim());
        }
      }
    }

    return globs;
  }
}
