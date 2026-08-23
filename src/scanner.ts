import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { ParsedRule, RuleKind, RuleRegistryState } from "./types.js";

export class RuleScanner {
  private cache: Map<string, ParsedRule> = new Map();

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
    const globalDir = path.join(agentDir, "rules");

    // Scan global first, then project (so project rules with same ID win)
    const globalFiles = await this.scanDirectory(globalDir, "global", logger);
    const projectFiles = await this.scanDirectory(projectDir, "project", logger);

    // Merge: index by rule ID
    const mergedById = new Map<string, ParsedRule>();
    for (const rule of globalFiles) {
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
        if (ext !== ".md" && ext !== ".mdc") continue;

        const filePath = path.join(dirPath, entry.name);
        currentFiles.add(filePath);

        try {
          const stat = await fs.stat(filePath);
          const signature = `${entry.name}:${stat.mtimeMs}:${stat.size}`;
          const cached = this.cache.get(filePath);

          if (cached && cached.rawSignature === signature) {
            results.push(cached);
            continue;
          }

          // Read and parse
          const raw = await fs.readFile(filePath, "utf-8");
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

    // 3. Path Rule (has globs, paths, or scope-extracted globs)
    const globs = this.normalizeGlobs(fm);
    if (globs.length > 0) {
      return "path_rule";
    }

    // 4. Default Rulebook
    return "rulebook";
  }

  /**
   * Checks if a rule declares a non-empty TTSR trigger condition.
   */
  private hasTtsrTrigger(fm: Record<string, unknown>): boolean {
    const trigger =
      fm.condition ??
      fm.astCondition ??
      fm.ast_condition ??
      fm.ttsr_trigger ??
      fm.ttsrTrigger;

    if (!trigger) return false;

    if (typeof trigger === "string") {
      return trigger.trim().length > 0;
    }
    if (Array.isArray(trigger)) {
      return trigger.some(
        (item) => typeof item === "string" && item.trim().length > 0
      );
    }
    return false;
  }

  /**
   * Normalizes globs field from string, array, comma-separated string, or scope tokens.
   */
  private normalizeGlobs(fm: Record<string, unknown>): string[] {
    const input = fm.globs ?? fm.paths;
    if (Array.isArray(input)) {
      return input.map(String).filter((s) => s.trim().length > 0);
    }
    if (typeof input === "string") {
      return input
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    // Fallback: extract globs from scope tokens like tool:edit(*.ts) if globs/paths absent
    if (typeof fm.scope === "string") {
      const matches = Array.from(
        fm.scope.matchAll(/tool:\w+\(([^)]+)\)/g)
      ).map((m) => m[1].trim());
      if (matches.length > 0) return matches;
    } else if (Array.isArray(fm.scope)) {
      const extracted: string[] = [];
      for (const item of fm.scope) {
        if (typeof item === "string") {
          const matches = Array.from(
            item.matchAll(/tool:\w+\(([^)]+)\)/g)
          ).map((m) => m[1].trim());
          extracted.push(...matches);
        }
      }
      if (extracted.length > 0) return extracted;
    }

    return [];
  }

  /**
   * Clear cache for testing or manual reload
   */
  clearCache(): void {
    this.cache.clear();
  }
}
