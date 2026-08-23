import * as path from "node:path";
import type { ChatMessage, MatchedRule, ParsedRule } from "./types.js";

/**
 * Converts a glob pattern into a regular expression.
 * Handles *, **, ?, and {a,b} expansions.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, "/");

  // Remove leading ./ if present
  if (p.startsWith("./")) {
    p = p.slice(2);
  }

  let regexStr = "^";
  let inGroup = false;

  for (let i = 0; i < p.length; i++) {
    const char = p[i];

    if (char === "*") {
      if (p[i + 1] === "*") {
        // Double star **
        if (p[i + 2] === "/") {
          regexStr += "(?:.*\\/)?";
          i += 2;
        } else {
          regexStr += ".*";
          i++;
        }
      } else {
        // Single star * (does not cross /)
        regexStr += "[^\\/]*";
      }
    } else if (char === "?") {
      regexStr += "[^\\/]";
    } else if (char === "{") {
      regexStr += "(";
      inGroup = true;
    } else if (char === "}" && inGroup) {
      regexStr += ")";
      inGroup = false;
    } else if (char === "," && inGroup) {
      regexStr += "|";
    } else if (
      char === "." ||
      char === "+" ||
      char === "(" ||
      char === ")" ||
      char === "^" ||
      char === "$" ||
      char === "[" ||
      char === "]" ||
      char === "|"
    ) {
      regexStr += `\\${char}`;
    } else {
      regexStr += char;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Checks if a given normalized path matches a glob pattern.
 */
export function matchesGlob(targetPath: string, pattern: string): boolean {
  const normPath = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

  // Exact match fast path
  if (normPath === normPattern) return true;

  // Simple wildcard file extension fast path (*.ts)
  if (normPattern.startsWith("*.") && !normPattern.includes("/")) {
    const ext = normPattern.slice(1);
    return normPath.endsWith(ext) && !normPath.slice(0, -ext.length).includes("/");
  }

  // General glob regex match
  try {
    const reg = globToRegExp(normPattern);
    return reg.test(normPath);
  } catch {
    return false;
  }
}

/**
 * Extracts active file paths strictly from the current turn.
 * Scope: The latest user prompt + any tool executions initiated within this turn.
 * Robustly inspects both string content and structured AgentMessage content blocks (toolCall, toolResult, text).
 */
export function extractActivePaths(
  messages: ChatMessage[],
  cwd: string
): string[] {
  const detectedPaths = new Set<string>();
  if (messages.length === 0) return [];

  // Find index of the most recent user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // Active turn messages = from the latest user message to the end of message array
  const activeTurnMessages =
    lastUserIdx !== -1 ? messages.slice(lastUserIdx) : [messages[messages.length - 1]];

  for (const msg of activeTurnMessages) {
    if (!msg || typeof msg !== "object") continue;

    // 1. Process message content (string or AgentMessage content blocks)
    inspectContent(msg.content, cwd, detectedPaths);

    // 2. Process top-level message tool call structures (if present)
    const directToolInput =
      (msg as Record<string, unknown>).input ||
      (msg as Record<string, unknown>).arguments;
    if (directToolInput && typeof directToolInput === "object") {
      inspectToolArguments(directToolInput as Record<string, unknown>, cwd, detectedPaths);
    }
    const toolCalls = (msg as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc && typeof tc === "object") {
          const fn = (tc as Record<string, unknown>).function;
          if (fn && typeof fn === "object") {
            const rawArgs = (fn as Record<string, unknown>).arguments;
            if (typeof rawArgs === "string") {
              try {
                inspectToolArguments(JSON.parse(rawArgs), cwd, detectedPaths);
              } catch {
                extractPathsFromText(rawArgs, cwd, detectedPaths);
              }
            } else if (rawArgs && typeof rawArgs === "object") {
              inspectToolArguments(rawArgs as Record<string, unknown>, cwd, detectedPaths);
            }
          }
        }
      }
    }
  }

  return Array.from(detectedPaths);
}

function inspectContent(
  content: unknown,
  cwd: string,
  outSet: Set<string>
): void {
  if (!content) return;

  if (typeof content === "string") {
    extractPathsFromText(content, cwd, outSet);
    return;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block) continue;
      if (typeof block === "string") {
        extractPathsFromText(block, cwd, outSet);
        continue;
      }
      if (typeof block === "object") {
        const b = block as Record<string, unknown>;

        // Text & Thinking blocks
        if (typeof b.text === "string") {
          extractPathsFromText(b.text, cwd, outSet);
        }

        // ToolCall blocks (type: "toolCall", "tool_call", "tool_use", "custom_tool_call")
        const toolArgs = b.arguments ?? b.args ?? b.input ?? b.parameters;
        if (toolArgs && typeof toolArgs === "object") {
          inspectToolArguments(toolArgs as Record<string, unknown>, cwd, outSet);
        } else if (typeof toolArgs === "string") {
          try {
            inspectToolArguments(JSON.parse(toolArgs), cwd, outSet);
          } catch {
            extractPathsFromText(toolArgs, cwd, outSet);
          }
        }

        // ToolResult blocks
        if (b.content && b.content !== content) {
          inspectContent(b.content, cwd, outSet);
        }
      }
    }
  }
}

function inspectToolArguments(
  args: Record<string, unknown>,
  cwd: string,
  outSet: Set<string>
): void {
  if (typeof args.path === "string") addNormalizedPath(args.path, cwd, outSet);
  if (typeof args.filePath === "string") addNormalizedPath(args.filePath, cwd, outSet);
  if (typeof args.file === "string") addNormalizedPath(args.file, cwd, outSet);
  if (typeof args.target === "string") addNormalizedPath(args.target, cwd, outSet);
  if (typeof args.filename === "string") addNormalizedPath(args.filename, cwd, outSet);

  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string") addNormalizedPath(p, cwd, outSet);
    }
  }
  if (Array.isArray(args.files)) {
    for (const p of args.files) {
      if (typeof p === "string") addNormalizedPath(p, cwd, outSet);
    }
  }

  // Shell/Bash command scanning
  if (typeof args.command === "string") {
    extractPathsFromText(args.command, cwd, outSet);
  }
}

function addNormalizedPath(
  rawPath: string,
  cwd: string,
  outSet: Set<string>
): void {
  if (!rawPath || typeof rawPath !== "string") return;
  // Ignore URLs or protocol URIs like rule:// or https:// or skill://
  if (
    rawPath.startsWith("http://") ||
    rawPath.startsWith("https://") ||
    rawPath.startsWith("rule://") ||
    rawPath.startsWith("skill://")
  ) {
    return;
  }

  // Strip line numbers or queries if present (e.g. "foo.ts:10-20" or "foo.ts?query")
  let clean = rawPath.trim().replace(/^['"]|['"]$/g, "");
  const colonIdx = clean.indexOf(":");
  if (colonIdx > 1 && !clean.includes(":\\")) {
    clean = clean.slice(0, colonIdx);
  }
  const qIdx = clean.indexOf("?");
  if (qIdx !== -1) {
    clean = clean.slice(0, qIdx);
  }

  if (!clean) return;

  // Normalize relative to cwd
  let relPath = clean;
  if (path.isAbsolute(clean)) {
    relPath = path.relative(cwd, clean);
  }

  const posixRel = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  // Ignore root / or outside-cwd traversal if undesirable, keep valid workspace relative paths
  if (posixRel && !posixRel.startsWith("../")) {
    outSet.add(posixRel);
  }
}

function extractPathsFromText(
  text: string,
  cwd: string,
  outSet: Set<string>
): void {
  // Regex to match potential file paths with extensions
  const pathRegex = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9_-]+|[\w.-]+\.[a-zA-Z0-9_-]+/g;
  const matches = text.match(pathRegex);
  if (!matches) return;

  for (const match of matches) {
    // Exclude URLs, command flags, or common noise
    if (match.startsWith("http://") || match.startsWith("https://")) continue;
    if (match.startsWith("--") || match.includes("..")) continue;
    addNormalizedPath(match, cwd, outSet);
  }
}

/**
 * Matches active paths against parsed rules and returns matched rules.
 */
export function matchActiveRules(
  rules: ParsedRule[],
  activePaths: string[]
): MatchedRule[] {
  const matchedList: MatchedRule[] = [];

  for (const rule of rules) {
    if (rule.kind !== "path_rule" || rule.globs.length === 0) {
      continue;
    }

    const matchedGlobs = new Set<string>();
    const matchedPaths = new Set<string>();

    for (const p of activePaths) {
      for (const g of rule.globs) {
        if (matchesGlob(p, g)) {
          matchedGlobs.add(g);
          matchedPaths.add(p);
        }
      }
    }

    if (matchedPaths.size > 0) {
      matchedList.push({
        rule,
        matchedGlobs: Array.from(matchedGlobs),
        matchedPaths: Array.from(matchedPaths),
      });
    }
  }

  // Sort by priority (descending), then by rule ID
  matchedList.sort((a, b) => {
    if (b.rule.priority !== a.rule.priority) {
      return b.rule.priority - a.rule.priority;
    }
    return a.rule.id.localeCompare(b.rule.id);
  });

  return matchedList;
}
