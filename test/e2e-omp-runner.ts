import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { startMockOpenAiServer } from "./mock-llm-server.js";

async function runRealOmpE2ETest(): Promise<void> {
  console.log("1. Starting mock OpenAI server on 127.0.0.1:19988...");
  const serverInstance = await startMockOpenAiServer(19988);

  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-home-test-"));
  const agentDir = path.join(tmpHome, ".omp", "agent");
  await fs.mkdir(agentDir, { recursive: true });

  // Configure mock-provider in models.yml with full schema compliance
  await fs.writeFile(
    path.join(agentDir, "models.yml"),
    `providers:
  mock-provider:
    baseUrl: http://127.0.0.1:19988/v1
    apiKey: mock-key
    api: openai-completions
    models:
      - id: mock-model
        name: Mock Model
        api: openai-completions
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
`
  );

  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "omp-proj-test-"));
  const rulesDir = path.join(tmpProject, ".omp", "rules");
  await fs.mkdir(rulesDir, { recursive: true });

  // 1. Create a path-rule
  await fs.writeFile(
    path.join(rulesDir, "api.md"),
    `---
globs: ["src/api/**/*.ts"]
priority: 100
---
Always validate with Zod.`
  );

  // 2. Create a TTSR rule (must not be pre-injected into prompt)
  await fs.writeFile(
    path.join(rulesDir, "ttsr-rule.md"),
    `---
condition: "eval\\\\("
scope: "tool:edit(*.ts)"
---
Never use eval.`
  );

  const extensionPath = path.resolve("src/index.ts");
  console.log(`2. Invoking real OMP CLI with extension: ${extensionPath}`);

  const env = {
    ...process.env,
    HOME: tmpHome,
    PI_CODING_AGENT_DIR: agentDir,
    MOCK_PROVIDER_API_KEY: "mock-key",
  };

  try {
    // === SCENARIO 1: Touch src/api/user.ts -> Rule MUST be injected ===
    console.log("Scenario 1: Testing rule injection on matching path...");
    const res1 = await executeOmpTurn(
      tmpProject,
      extensionPath,
      "Please update src/api/user.ts",
      env
    );

    console.log("Scenario 1 Output:", res1.stdout.trim());
    if (
      res1.code !== 0 ||
      !res1.stdout.includes("OMP_EXTENSION_VERIFIED_SUCCESSFULLY:RULE_INJECTED")
    ) {
      throw new Error(
        `Scenario 1 failed (expected RULE_INJECTED):\nSTDOUT: ${res1.stdout}\nSTDERR: ${res1.stderr}`
      );
    }
    console.log("✓ Scenario 1 passed: OMP CLI successfully loaded extension and injected matching path rule!");

    // === SCENARIO 2: Touch docs/readme.md -> Rule MUST NOT be injected (Eviction) ===
    console.log("Scenario 2: Testing rule eviction on non-matching path...");
    const res2 = await executeOmpTurn(
      tmpProject,
      extensionPath,
      "Please read docs/readme.md",
      env
    );

    console.log("Scenario 2 Output:", res2.stdout.trim());
    if (
      res2.code !== 0 ||
      !res2.stdout.includes("OMP_EXTENSION_VERIFIED_SUCCESSFULLY:RULE_EVICTED")
    ) {
      throw new Error(
        `Scenario 2 failed (expected RULE_EVICTED):\nSTDOUT: ${res2.stdout}\nSTDERR: ${res2.stderr}`
      );
    }
    console.log("✓ Scenario 2 passed: OMP CLI successfully evicted rule for non-matching path!");

    console.log("\n🎉 All real OMP CLI & Extension Loader E2E tests verified successfully without false-positives!");
  } finally {
    await serverInstance.close();
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
  }
}

function executeOmpTurn(
  cwd: string,
  extensionPath: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve, reject } =
    Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();

  const child = spawn(
    "omp",
    [
      "--no-session",
      `--cwd=${cwd}`,
      `--extension=${extensionPath}`,
      "--model=mock-provider/mock-model",
      "--no-tools",
      "-p",
      prompt,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );

  let stdout = "";
  let stderr = "";

  const timer: NodeJS.Timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`OMP execution timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });

  return promise;
}

runRealOmpE2ETest()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("E2E OMP Test Failure:", err);
    process.exit(1);
  });
