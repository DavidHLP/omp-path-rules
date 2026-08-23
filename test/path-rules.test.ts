import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ompPathRules from "../src/index.js";
import {
  buildRulesPromptBlock,
  injectRulesIntoMessages,
} from "../src/injector.js";
import {
  extractActivePaths,
  globToRegExp,
  matchesGlob,
  matchActiveRules,
} from "../src/matcher.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { RuleScanner } from "../src/scanner.js";
import type { ChatMessage, ContextEvent, ExtensionAPI, ExtensionContext, ParsedRule } from "../src/types.js";

describe("Frontmatter Parser", () => {
  it("parses valid yaml frontmatter with array and booleans", () => {
    const raw = `---
description: "React Guidelines"
globs: ["src/components/**/*.tsx", "src/pages/**/*.tsx"]
alwaysApply: false
priority: 50
---
# React Rules
Keep components pure.`;

    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.description).toBe("React Guidelines");
    expect(frontmatter.globs).toEqual([
      "src/components/**/*.tsx",
      "src/pages/**/*.tsx",
    ]);
    expect(frontmatter.alwaysApply).toBe(false);
    expect(frontmatter.priority).toBe(50);
    expect(body).toBe("# React Rules\nKeep components pure.");
  });

  it("handles block-style lists in frontmatter", () => {
    const raw = `---
globs:
  - "src/**/*.ts"
  - "test/**/*.ts"
---
Body content`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.globs).toEqual(["src/**/*.ts", "test/**/*.ts"]);
    expect(body).toBe("Body content");
  });

  it("fails open on malformed frontmatter without throwing", () => {
    const raw = `---
invalid : :: yaml
---
Body content`;
    const { body } = parseFrontmatter(raw);
    expect(body).toBe("Body content");
  });

  it("returns raw text when no frontmatter is present", () => {
    const raw = `# Plain markdown
No frontmatter here`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });
});

describe("Glob Matcher", () => {
  it("matches basic file extensions", () => {
    expect(matchesGlob("src/index.ts", "*.ts")).toBe(false);
    expect(matchesGlob("index.ts", "*.ts")).toBe(true);
    expect(matchesGlob("src/index.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/api/user.ts", "src/*.ts")).toBe(false);
  });

  it("matches recursive wildcards (**)", () => {
    expect(matchesGlob("src/api/v1/user.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/index.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("lib/api/user.ts", "src/**/*.ts")).toBe(false);
  });

  it("matches multi-extension groups {ts,tsx}", () => {
    expect(matchesGlob("src/Button.tsx", "src/**/*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("src/util.ts", "src/**/*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("src/style.css", "src/**/*.{ts,tsx}")).toBe(false);
  });
});

describe("Scanner & Rule Classification (TTSR Coexistence)", () => {
  it("strictly distinguishes accepted TTSR rules from Path-Rules and Always-Apply", () => {
    const scanner = new RuleScanner();

    // 1. TTSR with regex condition + scope
    expect(
      scanner.classifyRule({ condition: "legacy_pattern", scope: "tool:edit(*.ts)" })
    ).toBe("ttsr_stream");

    // 2. TTSR with astCondition
    expect(
      scanner.classifyRule({ astCondition: "$_.legacyMethod()" })
    ).toBe("ttsr_stream");

    // 3. TTSR with ast_condition array
    expect(
      scanner.classifyRule({ ast_condition: ["pattern1", "pattern2"] })
    ).toBe("ttsr_stream");

    // 4. TTSR with snake_case ttsr_trigger
    expect(
      scanner.classifyRule({ ttsr_trigger: "dangerous_call" })
    ).toBe("ttsr_stream");

    // 5. TTSR with camelCase ttsrTrigger (legacy compatibility)
    expect(
      scanner.classifyRule({ ttsrTrigger: "dangerous_call" })
    ).toBe("ttsr_stream");

    // 6. Scope-only rule WITHOUT condition -> Must NOT be marked as TTSR!
    // It should be treated as a path rule extracting *.ts from scope
    expect(
      scanner.classifyRule({ scope: "tool:edit(*.ts)" })
    ).toBe("path_rule");

    // 7. Scope-only array without condition -> path_rule
    expect(
      scanner.classifyRule({ scope: ["tool:write(*.js)", "tool:edit(*.ts)"] })
    ).toBe("path_rule");

    // 8. Empty condition with globs -> path_rule
    expect(
      scanner.classifyRule({ condition: "", globs: ["src/**/*.ts"] })
    ).toBe("path_rule");

    // 9. Always-Apply Rule (Native system prompt)
    expect(scanner.classifyRule({ alwaysApply: true })).toBe("always_apply");

    // 10. Standard Path Rule
    expect(scanner.classifyRule({ globs: ["src/**/*.ts"] })).toBe("path_rule");

    // 11. Plain Rulebook (No globs, no condition, no alwaysApply)
    expect(scanner.classifyRule({ description: "general info" })).toBe("rulebook");
  });

  it("scans temporary directory and handles mtime signature cache", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rules-test-"));
    const rulesDir = path.join(tmpDir, ".omp", "rules");
    await fs.mkdir(rulesDir, { recursive: true });

    const ruleFile = path.join(rulesDir, "api-rules.md");
    await fs.writeFile(
      ruleFile,
      `---
globs: ["src/api/**/*.ts"]
priority: 100
---
API standards: Always use zod.`
    );

    const scanner = new RuleScanner();
    const rules1 = await scanner.scan(tmpDir);
    expect(rules1.length).toBe(1);
    expect(rules1[0].id).toBe("api-rules");
    expect(rules1[0].kind).toBe("path_rule");

    // Second scan should hit cache
    const rules2 = await scanner.scan(tmpDir);
    expect(rules2.length).toBe(1);

    // Clean up
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe("Active Path Extractor & Native AgentMessage Shapes", () => {
  it("extracts paths from structured native AgentMessage content blocks", () => {
    const cwd = "/app";
    const messages: ChatMessage[] = [
      // Turn 1 (Old turn — should be ignored)
      {
        role: "user",
        content: [{ type: "text", text: "Look at old/stale.ts" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "/app/old/stale.ts" },
          },
        ],
      },
      // Turn 2 (Current turn)
      {
        role: "user",
        content: [{ type: "text", text: "Please review src/api/auth.ts and app/routes.tsx" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            text: "Inspecting database client in src/db/client.ts",
          },
          {
            type: "toolCall",
            id: "call_2",
            name: "read",
            arguments: { path: "/app/src/db/client.ts" },
          },
          {
            type: "toolCall",
            id: "call_3",
            name: "bash",
            arguments: { command: "git diff src/models/user.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "toolResult",
            id: "call_2",
            content: "export const db = ... found in src/db/pool.ts:10-25",
          },
        ],
      },
    ];

    const activePaths = extractActivePaths(messages, cwd);
    expect(activePaths).toContain("src/api/auth.ts");
    expect(activePaths).toContain("app/routes.tsx");
    expect(activePaths).toContain("src/db/client.ts");
    expect(activePaths).toContain("src/models/user.ts");
    expect(activePaths).toContain("src/db/pool.ts");

    // Old turn paths must be evicted
    expect(activePaths).not.toContain("old/stale.ts");
  });

  it("supports OpenAI-style tool_calls with JSON-stringified arguments", () => {
    const cwd = "/app";
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "Modify component",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_edit",
            type: "function",
            function: {
              name: "edit",
              arguments: JSON.stringify({ path: "src/components/Header.tsx" }),
            },
          },
        ],
      },
    ];

    const activePaths = extractActivePaths(messages, cwd);
    expect(activePaths).toContain("src/components/Header.tsx");
  });

  it("matches active paths against rules and sorts by priority", () => {
    const rules: ParsedRule[] = [
      {
        id: "low-pri",
        filePath: "/app/.omp/rules/low.md",
        scope: "project",
        kind: "path_rule",
        frontmatter: {},
        globs: ["src/**/*.ts"],
        priority: 10,
        content: "Low priority content",
        rawSignature: "sig1",
      },
      {
        id: "high-pri",
        filePath: "/app/.omp/rules/high.md",
        scope: "project",
        kind: "path_rule",
        frontmatter: {},
        globs: ["src/api/**/*.ts"],
        priority: 100,
        content: "High priority content",
        rawSignature: "sig2",
      },
    ];

    const matched = matchActiveRules(rules, ["src/api/auth.ts"]);
    expect(matched.length).toBe(2);
    // Highest priority first
    expect(matched[0].rule.id).toBe("high-pri");
    expect(matched[1].rule.id).toBe("low-pri");
  });
});

describe("Injector & Prompt Budget", () => {
  it("builds prompt block and respects character budget limit", () => {
    const dummyRule: ParsedRule = {
      id: "big-rule",
      filePath: "/test.md",
      scope: "project",
      kind: "path_rule",
      frontmatter: {},
      globs: ["src/**/*.ts"],
      priority: 100,
      content: "X".repeat(500),
      rawSignature: "sig",
    };

    const matched = [
      { rule: dummyRule, matchedGlobs: ["src/**/*.ts"], matchedPaths: ["src/index.ts"] },
    ];

    const block = buildRulesPromptBlock(matched, { maxCharacters: 1000 });
    expect(block).not.toBeNull();
    expect(block).toContain("<active_path_rules>");
    expect(block).toContain("big-rule");
    expect(block).toContain("</active_path_rules>");
  });

  it("injects synthetic message and replaces previous injections", () => {
    const initialMessages: ChatMessage[] = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Hello" },
    ];

    const block1 = "<active_path_rules>\nRule 1\n</active_path_rules>";
    const res1 = injectRulesIntoMessages(initialMessages, block1);
    expect(res1.length).toBe(3);
    expect(res1[0].role).toBe("developer");
    
    const contentBlocks1 = res1[0].content as Array<{ text: string }>;
    expect(contentBlocks1[0].text).toBe(block1);

    // Re-injecting with a new block should replace block1 rather than stack
    const block2 = "<active_path_rules>\nRule 2\n</active_path_rules>";
    const res2 = injectRulesIntoMessages(res1, block2);
    expect(res2.length).toBe(3);
    expect(res2[0].role).toBe("developer");
    
    const contentBlocks2 = res2[0].content as Array<{ text: string }>;
    expect(contentBlocks2[0].text).toBe(block2);
  });
});

describe("End-to-End Extension Hook Flow", () => {
  it("registers hooks and injects rules on context event with structured messages", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-e2e-test-"));
    const rulesDir = path.join(tmpDir, ".omp", "rules");
    await fs.mkdir(rulesDir, { recursive: true });

    await fs.writeFile(
      path.join(rulesDir, "frontend.md"),
      `---
globs: ["src/ui/**/*.tsx"]
---
Use Tailwind for UI.`
    );

    let contextHandler: ((event: ContextEvent, ctx: ExtensionContext) => Promise<{ messages?: ChatMessage[] } | void> | { messages?: ChatMessage[] } | void) | undefined;
    let label = "";

    const mockPi: ExtensionAPI = {
      setLabel(l: string) {
        label = l;
      },
      on: ((event: string, handler: (event: ContextEvent, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
        if (event === "context") {
          contextHandler = handler as (event: ContextEvent, ctx: ExtensionContext) => Promise<{ messages?: ChatMessage[] } | void>;
        }
      }) as ExtensionAPI["on"],
      registerCommand() {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    };

    ompPathRules(mockPi);
    expect(label).toBe("omp-path-rules");
    expect(contextHandler).toBeDefined();

    const ctx: ExtensionContext = {
      cwd: tmpDir,
      ui: {
        setStatus() {},
        notify() {},
      },
    };

    // Native AgentMessage structure
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Please update the navbar component" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc_read_1",
            name: "read",
            arguments: { path: `${tmpDir}/src/ui/Navbar.tsx` },
          },
        ],
      },
    ];

    if (contextHandler) {
      const result = await contextHandler({ messages }, ctx);
      expect(result).toBeDefined();
      expect(result?.messages?.length).toBe(3);
      expect(JSON.stringify(result?.messages?.[0]?.content)).toContain("Use Tailwind for UI.");
    }

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
