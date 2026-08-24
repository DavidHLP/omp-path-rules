import * as path from "node:path";
import { registerPathRulesCommands } from "./commands.js";
import {
  buildRulesPromptBlock,
  injectRulesIntoMessages,
} from "./injector.js";
import { extractActivePaths, matchActiveRules } from "./matcher.js";
import { RuleScanner } from "./scanner.js";
import type {
  ExtensionAPI,
  ReadTelemetry,
  TurnUsage,
} from "./types.js";

export * from "./types.js";
export * from "./frontmatter.js";
export * from "./scanner.js";
export * from "./matcher.js";
export * from "./injector.js";

function normalizeProjectRelativePath(rawPath: string, cwd: string): string {
  if (!rawPath) return "";
  if (
    rawPath.startsWith("http://") ||
    rawPath.startsWith("https://") ||
    rawPath.startsWith("rule://") ||
    rawPath.startsWith("skill://")
  ) {
    return "";
  }

  let clean = rawPath.trim().replace(/^['"]|['"]$/g, "");
  const colonIdx = clean.indexOf(":");
  if (colonIdx > 1 && !clean.includes(":\\")) clean = clean.slice(0, colonIdx);
  const queryIdx = clean.indexOf("?");
  if (queryIdx !== -1) clean = clean.slice(0, queryIdx);
  if (!clean) return "";

  const relative = path.isAbsolute(clean) ? path.relative(cwd, clean) : clean;
  const posixRelative = relative.replace(/\\/g, "/").replace(/^\.\//, "");
  return posixRelative && !posixRelative.startsWith("../") ? posixRelative : "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatReadStats(read: ReadTelemetry | undefined): string {
  if (!read) return "";
  const stats: string[] = [];
  if (read.fileSize !== undefined) stats.push(formatBytes(read.fileSize));
  if (read.totalLines !== undefined) stats.push(`${read.totalLines} lines`);
  if (read.durationMs !== undefined) stats.push(`${(read.durationMs / 1000).toFixed(1)}s`);
  return stats.length > 0 ? ` (${stats.join(", ")})` : "";
}

/**
 * omp-path-rules Extension Entrypoint
 */
export default function ompPathRules(pi: ExtensionAPI): void {
  pi.setLabel("omp-path-rules");

  const scanner = new RuleScanner();
  let currentCwd = process.cwd();
  let lastNotifiedRuleSet = "";
  const activeReads = new Map<string, ReadTelemetry>();
  const pendingReads = new Map<string, ReadTelemetry>();
  let lastTurnUsage: TurnUsage | undefined;

  // 1. Session start lifecycle hook
  pi.on("session_start", async (_event, ctx) => {
    lastNotifiedRuleSet = "";
    currentCwd = ctx.cwd;
    activeReads.clear();
    pendingReads.clear();
    lastTurnUsage = undefined;
    try {
      const rules = await scanner.scan(ctx.cwd, pi.logger);
      const pathRulesCount = rules.filter((r) => r.kind === "path_rule").length;
      ctx.ui?.setStatus?.(
        "path-rules",
        pathRulesCount > 0 ? `rules: ${pathRulesCount} loaded` : undefined
      );
    } catch (err) {
      pi.logger.warn(
        `[omp-path-rules] Failed to initialize rules on session_start: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  });

  pi.on("tool_execution_start", (event, _ctx) => {
    if (event.toolName !== "read" || !event.toolCallId) return;
    const args =
      event.args && typeof event.args === "object"
        ? (event.args as Record<string, unknown>)
        : {};
    const rawPath = typeof args.path === "string" ? args.path : "";
    const normalizedPath = normalizeProjectRelativePath(rawPath, currentCwd);
    pendingReads.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      path: normalizedPath || rawPath,
      startedAt: Date.now(),
    });
  });

  pi.on("tool_execution_end", (event, _ctx) => {
    if (event.toolName !== "read" || !event.toolCallId) return;
    const read = pendingReads.get(event.toolCallId);
    if (!read) return;
    pendingReads.delete(event.toolCallId);
    read.durationMs = Date.now() - read.startedAt;
    activeReads.set(read.path, read);
  });

  pi.on("tool_result", (event, _ctx) => {
    if (event.toolName !== "read" || !event.input) return;
    const rawPath = typeof event.input.path === "string" ? event.input.path : "";
    const normalizedPath = normalizeProjectRelativePath(rawPath, currentCwd);
    const pathKey = normalizedPath || rawPath;
    const read =
      (event.toolCallId ? pendingReads.get(event.toolCallId) : undefined) ??
      activeReads.get(pathKey);
    if (!read || !event.details || typeof event.details !== "object") return;

    const metadata = event.details as Record<string, unknown>;
    read.resolvedPath =
      typeof metadata.resolvedPath === "string"
        ? metadata.resolvedPath
        : undefined;
    read.fileSize =
      typeof metadata.fileSize === "number" ? metadata.fileSize : undefined;
    read.totalLines =
      typeof metadata.totalLines === "number" ? metadata.totalLines : undefined;
    activeReads.set(read.path, read);
  });

  pi.on("turn_end", (event, _ctx) => {
    const message =
      event.message && typeof event.message === "object"
        ? (event.message as Record<string, unknown>)
        : {};
    const usage =
      message.usage && typeof message.usage === "object"
        ? (message.usage as Record<string, unknown>)
        : undefined;
    if (!usage) return;
    lastTurnUsage = {
      input: typeof usage.input === "number" ? usage.input : 0,
      output: typeof usage.output === "number" ? usage.output : 0,
      cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
    };
  });

  // 2. Pre-Turn Context Injection Hook
  pi.on("context", async (event, ctx) => {
    currentCwd = ctx.cwd;
    const messages = event?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    try {
      const rules = await scanner.scan(ctx.cwd, pi.logger);
      const activePaths = extractActivePaths(messages, ctx.cwd);
      if (activePaths.length === 0) {
        const cleanMessages = injectRulesIntoMessages(messages, null);
        ctx.ui?.setStatus?.("path-rules", undefined);
        if (lastNotifiedRuleSet !== "") {
          ctx.ui?.notify?.("[path-rules] Cleared active rules (no matching paths).", "info");
          lastNotifiedRuleSet = "";
        }
        return { messages: cleanMessages };
      }

      const matched = matchActiveRules(rules, activePaths);
      const rulesBlock = buildRulesPromptBlock(matched);
      const updatedMessages = injectRulesIntoMessages(messages, rulesBlock);

      ctx.ui?.setStatus?.(
        "path-rules",
        matched.length > 0 ? `rules: ${matched.length} active` : undefined
      );

      const ruleSetKey = matched
        .map((item) => `${item.rule.id}:${[...item.matchedPaths].sort().join(",")}`)
        .join("|");
      if (ruleSetKey !== lastNotifiedRuleSet && matched.length > 0) {
        const theme = ctx.ui?.theme;
        const color = (name: string, text: string): string => theme?.fg(name, text) ?? text;
        const displayPaths = [
          ...new Set(matched.flatMap((item) => item.matchedPaths)),
        ].sort();
        const treeLines =
          displayPaths.length > 0
            ? displayPaths.map((pathValue, index) => {
                const branch = index === displayPaths.length - 1 ? "'--" : "|--";
                const read = activeReads.get(pathValue);
                return `   ${color("dim", branch)} ${color("muted", `${pathValue}${formatReadStats(read)}`)}`;
              })
            : matched.map((item, index) => {
                const branch = index === matched.length - 1 ? "'--" : "|--";
                return `   ${color("dim", branch)} ${color("success", item.rule.id)}`;
              });
        const message = [
          `* ${color("text", "Loaded rules")} ${color("dim", `(${matched.length})`)}`,
          ...treeLines,
        ].join("\n");
        ctx.ui?.notify?.(message, "info");
        lastNotifiedRuleSet = ruleSetKey;
      }

      return { messages: updatedMessages };
    } catch (err) {
      pi.logger.warn(
        `[omp-path-rules] Context injection error (fail-open pass-through): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return { messages };
    }
  });

  // 3. Register Slash Command (/path-rules)
  registerPathRulesCommands(pi, scanner);
}
