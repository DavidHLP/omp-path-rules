import { matchesGlob } from "./matcher.js";
import type { RuleScanner } from "./scanner.js";
import type { ExtensionAPI, ExtensionCommandContext } from "./types.js";

export function registerPathRulesCommands(
  pi: ExtensionAPI,
  scanner: RuleScanner
): void {
  pi.registerCommand("path-rules", {
    description: "Manage and inspect dynamic path-based context rules (/path-rules [list|reload|test <path>])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subCommand = parts[0]?.toLowerCase() || "list";

      if (subCommand === "reload") {
        scanner.clearCache();
        const rules = await scanner.scan(ctx.cwd, pi.logger);
        const pathRulesCount = rules.filter((r) => r.kind === "path_rule").length;
        ctx.ui?.notify(
          `Reloaded ${rules.length} rule(s) (${pathRulesCount} active path-rules).`,
          "info"
        );
        return;
      }

      if (subCommand === "test") {
        const testPath = parts[1];
        if (!testPath) {
          ctx.ui?.notify("Usage: /path-rules test <file-path>", "warning");
          return;
        }

        const rules = await scanner.scan(ctx.cwd, pi.logger);
        const matched = rules.filter((r) => {
          if (r.kind !== "path_rule") return false;
          return r.globs.some((g) => matchesGlob(testPath, g));
        });

        if (matched.length === 0) {
          ctx.ui?.notify(`No path-rules matched for path: "${testPath}"`, "info");
        } else {
          const names = matched.map((m) => `${m.id} (${m.globs.join(", ")})`).join("; ");
          ctx.ui?.notify(
            `Matched ${matched.length} rule(s) for "${testPath}": ${names}`,
            "info"
          );
        }
        return;
      }

      // Default: list
      const rules = await scanner.scan(ctx.cwd, pi.logger);
      if (rules.length === 0) {
        ctx.ui?.notify(
          "No rules found in .omp/rules or ~/.omp/agent/rules.",
          "info"
        );
        return;
      }

      const summary = rules
        .map((r) => {
          const kindTag =
            r.kind === "path_rule"
              ? `[PATH: ${r.globs.join(",")}]`
              : r.kind === "ttsr_stream"
              ? "[TTSR (Native Stream)]"
              : r.kind === "always_apply"
              ? "[ALWAYS-APPLY (Native System)]"
              : "[RULEBOOK]";
          return `- ${r.id} (${r.scope}) ${kindTag}`;
        })
        .join("\n");

      ctx.ui?.notify(`Discovered ${rules.length} rule(s):\n${summary}`, "info");
    },
  });
}
