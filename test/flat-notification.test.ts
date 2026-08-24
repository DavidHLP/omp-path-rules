import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ompPathRules from "../src/index.js";
import type { ExtensionAPI, ExtensionContext } from "../src/types.js";

it("notifies matched project paths with hierarchical matched rules and telemetry", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-notification-test-"));
  await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".omp", "rules", "java-backend.md"),
    "---\nglobs: [\".omp/java-backend-**\", \"src/**/*.java\"]\n---\nBackend rules"
  );

  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let notification = "";
  const pi: ExtensionAPI = {
    setLabel() {},
    on: ((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
    }) as ExtensionAPI["on"],
    registerCommand() {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  ompPathRules(pi);

  const ctx: ExtensionContext = {
    cwd,
    ui: { setStatus() {}, notify(message) { notification = message; } },
  };
  handlers.get("session_start")?.({}, ctx);
  handlers.get("tool_execution_start")?.(
    {
      toolName: "read",
      toolCallId: "read-1",
      args: { path: path.join(cwd, ".omp", "java-backend-path") },
    },
    ctx
  );
  handlers.get("tool_execution_end")?.(
    { toolName: "read", toolCallId: "read-1" },
    ctx
  );
  handlers.get("tool_result")?.(
    {
      toolName: "read",
      toolCallId: "read-1",
      input: { path: path.join(cwd, ".omp", "java-backend-path") },
      details: { fileSize: 5632, totalLines: 73 },
    },
    ctx
  );
  const contextHandler = handlers.get("context");
  const result = await contextHandler?.(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Review the backend files" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-1",
              name: "read",
              arguments: { path: path.join(cwd, ".omp", "java-backend-path") },
            },
            {
              type: "toolCall",
              id: "read-2",
              name: "read",
              arguments: { path: path.join(cwd, "src", "Main.java") },
            },
          ],
        },
      ],
    },
    ctx
  );

  expect(result).toBeDefined();
  expect(notification).toMatch(
    /^\* Loaded rules \(1\)\n   \|-- \.omp\/java-backend-path \(5\.5K, 73 lines, 0\.0s\)\n   \|   '-- java-backend\n   '-- src\/Main\.java\n       '-- java-backend$/
  );

  await fs.rm(cwd, { recursive: true, force: true });
});

it("notifies service/backend source paths with hierarchical rules and telemetry", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-notification-test-"));
  await fs.mkdir(path.join(cwd, ".omp", "rules"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".omp", "rules", "java-backend-path.md"),
    "---\nglobs: [\"services/**/*.java\"]\n---\nJava backend rules"
  );
  await fs.writeFile(
    path.join(cwd, ".omp", "rules", "springboot-rules-path.md"),
    "---\nglobs: [\"services/**/src/**/*.{java,yml,yaml,properties}\"]\n---\nSpring Boot rules"
  );

  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let notification = "";
  const pi: ExtensionAPI = {
    setLabel() {},
    on: ((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
    }) as ExtensionAPI["on"],
    registerCommand() {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  ompPathRules(pi);

  const ctx: ExtensionContext = {
    cwd,
    ui: { setStatus() {}, notify(message) { notification = message; } },
  };
  handlers.get("session_start")?.({}, ctx);

  const samplePath = "services/api/submission-api/src/main/java/com/ulticode/submission/api/service/SubmissionFencePort.java";
  handlers.get("tool_execution_start")?.(
    {
      toolName: "read",
      toolCallId: "read-fence-port",
      args: { path: path.join(cwd, samplePath) },
    },
    ctx
  );
  handlers.get("tool_execution_end")?.(
    { toolName: "read", toolCallId: "read-fence-port" },
    ctx
  );
  handlers.get("tool_result")?.(
    {
      toolName: "read",
      toolCallId: "read-fence-port",
      input: { path: path.join(cwd, samplePath) },
      details: { fileSize: 5400, totalLines: 34 },
    },
    ctx
  );

  const contextHandler = handlers.get("context");
  const result = await contextHandler?.(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Check submission fence" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-fence-port",
              name: "read",
              arguments: { path: path.join(cwd, samplePath) },
            },
          ],
        },
      ],
    },
    ctx
  );

  expect(result).toBeDefined();
  expect(notification).toContain("* Loaded rules (2)");
  expect(notification).toContain(samplePath);
  expect(notification).toContain("5.3K, 34 lines");
  expect(notification).toContain("java-backend-path");
  expect(notification).toContain("springboot-rules-path");

  // Verify tree indentation format for child rules
  expect(notification).toMatch(
    /services\/api\/submission-api\/src\/main\/java\/com\/ulticode\/submission\/api\/service\/SubmissionFencePort\.java \(5\.3K, 34 lines, 0\.0s\)\n       \|-- java-backend-path\n       '-- springboot-rules-path/
  );

  await fs.rm(cwd, { recursive: true, force: true });
});
