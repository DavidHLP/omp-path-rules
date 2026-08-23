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
 * Older turns are excluded to guarantee single-turn transient scope and instant eviction.
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
    if (typeof msg === "object" && msg !== null) {
      // 1. Tool Call inputs (e.g. read, edit, write, etc.)
      const toolInput = (msg as Record<string, unknown>).input || msg;
      if (typeof toolInput === "object" && toolInput !== null) {
        const inp = toolInput as Record<string, unknown>;
        if (typeof inp.path === "string") addNormalizedPath(inp.path, cwd, detectedPaths);
        if (typeof inp.filePath === "string") addNormalizedPath(inp.filePath, cwd, detectedPaths);
        if (typeof inp.file === "string") addNormalizedPath(inp.file, cwd, detectedPaths);

        // Bash command scanning in active tool call
        if (typeof inp.command === "string") {
          extractPathsFromText(inp.command, cwd, detectedPaths);
        }
      }

      // 2. Message content text (user prompt or tool result)
      if (typeof msg.content === "string") {
        extractPathsFromText(msg.content, cwd, detectedPaths);
      }
    }
  }

  return Array.from(detectedPaths);
}

function addNormalizedPath(
  rawPath: string,
  cwd: string,
  outSet: Set<string>
): void {
  if (!rawPath || typeof rawPath !== "string") return;
  const clean = rawPath.trim().replace(/^['"]|['"]$/g, "");
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
