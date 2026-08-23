import type { ChatMessage, MatchedRule } from "./types.js";

const DEFAULT_MAX_CHARS = 16_000; // ~4000 tokens

export interface InjectorOptions {
  maxCharacters?: number;
}

/**
 * Builds the <active_path_rules> prompt block from matched rules, respecting character budget.
 */
export function buildRulesPromptBlock(
  matchedRules: MatchedRule[],
  options: InjectorOptions = {}
): string | null {
  if (matchedRules.length === 0) {
    return null;
  }

  const maxChars = options.maxCharacters ?? DEFAULT_MAX_CHARS;
  const sections: string[] = [];
  let currentChars = 0;
  let omittedCount = 0;

  const header = `<active_path_rules>\n# Dynamically Activated Context Rules\nThe following rules are automatically activated because your current working files match their path patterns:\n`;
  currentChars += header.length + 30; // buffer for footer

  for (const item of matchedRules) {
    const pathsStr = item.matchedPaths.join(", ");
    const globsStr = item.matchedGlobs.join(", ");
    const ruleTitle = `## [Rule: ${item.rule.id}] (Scope: ${item.rule.scope}, Pattern: ${globsStr}, Active: ${pathsStr})`;
    const ruleBlock = `\n${ruleTitle}\n${item.rule.content.trim()}\n`;

    if (currentChars + ruleBlock.length > maxChars) {
      omittedCount++;
      continue;
    }

    sections.push(ruleBlock);
    currentChars += ruleBlock.length;
  }

  if (sections.length === 0) {
    return null;
  }

  let result = header + sections.join("\n");
  if (omittedCount > 0) {
    result += `\n<!-- [omp-path-rules] ${omittedCount} additional rule(s) omitted due to token budget limit -->\n`;
  }
  result += `</active_path_rules>`;

  return result;
}

/**
 * Injects or updates the <active_path_rules> block in the messages pipeline.
 * Formatted as an OMP-native "developer" role message with structured text content block.
 * Strips previous dynamic rules to ensure idempotency across turns.
 */
export function injectRulesIntoMessages(
  messages: ChatMessage[],
  rulesBlock: string | null
): ChatMessage[] {
  const filteredMessages: ChatMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      filteredMessages.push(msg);
      continue;
    }

    let isSyntheticRulesMessage = false;
    if (msg.role === "developer" || msg.role === "system") {
      if (typeof msg.content === "string") {
        isSyntheticRulesMessage = msg.content.includes("<active_path_rules>");
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === "object" &&
            typeof (block as Record<string, unknown>).text === "string" &&
            ((block as Record<string, unknown>).text as string).includes("<active_path_rules>")
          ) {
            isSyntheticRulesMessage = true;
            break;
          }
        }
      }
    }

    if (isSyntheticRulesMessage) {
      // Drop previous synthetic message
      continue;
    }

    filteredMessages.push(msg);
  }

  if (!rulesBlock) {
    return filteredMessages;
  }

  // Prepend fresh synthetic developer message (OMP native AgentMessage developer role)
  const syntheticMsg: ChatMessage = {
    role: "developer",
    content: [{ type: "text", text: rulesBlock }],
  };

  return [syntheticMsg, ...filteredMessages];
}
