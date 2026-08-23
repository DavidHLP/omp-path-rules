import { registerPathRulesCommands } from "./commands.js";
import {
  buildRulesPromptBlock,
  injectRulesIntoMessages,
} from "./injector.js";
import { extractActivePaths, matchActiveRules } from "./matcher.js";
import { RuleScanner } from "./scanner.js";
import type { ExtensionAPI } from "./types.js";

export * from "./types.js";
export * from "./frontmatter.js";
export * from "./scanner.js";
export * from "./matcher.js";
export * from "./injector.js";

/**
 * omp-path-rules Extension Entrypoint
 */
export default function ompPathRules(pi: ExtensionAPI): void {
  pi.setLabel("omp-path-rules");

  const scanner = new RuleScanner();
  let lastNotifiedRuleSet = "";
  // 1. Session start lifecycle hook
  pi.on("session_start", async (_event, ctx) => {
    lastNotifiedRuleSet = "";
    try {
      const rules = await scanner.scan(ctx.cwd, pi.logger);
      const pathRulesCount = rules.filter((r) => r.kind === "path_rule").length;
      if (ctx.ui?.setStatus) {
        ctx.ui.setStatus(
          "path-rules",
          pathRulesCount > 0 ? `rules: ${pathRulesCount} loaded` : undefined
        );
      }
    } catch (err) {
      pi.logger.warn(
        `[omp-path-rules] Failed to initialize rules on session_start: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  });

  // 2. Pre-Turn Context Injection Hook
  pi.on("context", async (event, ctx) => {
    const messages = event?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    try {
      // Step A: Refresh rules from cache / disk
      const rules = await scanner.scan(ctx.cwd, pi.logger);
      const activePaths = extractActivePaths(messages, ctx.cwd);
      if (activePaths.length === 0) {
        // Strip previous injected rules if any and exit
        const cleanMessages = injectRulesIntoMessages(messages, null);
        ctx.ui?.setStatus?.("path-rules", undefined);
        if (lastNotifiedRuleSet !== "") {
          ctx.ui?.notify?.("[path-rules] Cleared active rules (no matching paths).", "info");
          lastNotifiedRuleSet = "";
        }
        return { messages: cleanMessages };
      }
      // Step C: Match active paths against rule globs
      const matched = matchActiveRules(rules, activePaths);

      // Step D: Format and budget prompt block
      const rulesBlock = buildRulesPromptBlock(matched);

      // Step E: Inject synthetic system block
      const updatedMessages = injectRulesIntoMessages(messages, rulesBlock);

      // Step F: Update UI status indicator
      if (ctx.ui?.setStatus) {
        if (matched.length > 0) {
          ctx.ui.setStatus("path-rules", `rules: ${matched.length} active`);
        } else {
          ctx.ui.setStatus("path-rules", undefined);
        }
      }

      const ruleSetKey = matched
        .map(
          (item) =>
            `${item.rule.id}:${[...item.matchedPaths].sort().join(",")}`
        )
        .join("|");
      if (ruleSetKey !== lastNotifiedRuleSet) {
        if (matched.length > 0) {
          const details = matched.map((item) => item.rule.id).join(", ");
          ctx.ui?.notify?.(`[path-rules] Loaded rules: ${details}`, "info");
        }
        lastNotifiedRuleSet = ruleSetKey;
      }

      return { messages: updatedMessages };
    } catch (err) {
      // Fail-open: Never block or crash the agent session if rule injection fails
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
