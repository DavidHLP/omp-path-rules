import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { startMockOpenAiServer } from "./mock-llm-server.js";

async function runRealOmpE2ETest(): Promise<void> {
  console.log("==> 1. Initializing Mock OpenAI LLM Server on 127.0.0.1:19988...");
  const serverInstance = await startMockOpenAiServer(19988);

  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-e2e-home-"));
  const agentDir = path.join(tmpHome, ".omp", "agent");
  const agentRulesDir = path.join(agentDir, "rules");
  const homeRulesDir = path.join(tmpHome, ".omp", "rules");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(agentRulesDir, { recursive: true });
  await fs.mkdir(homeRulesDir, { recursive: true });

  // 1. Configure user-level models.yml with full OMP schema compliance
  await fs.writeFile(
    path.join(agentDir, "models.yml"),
    `providers:
  mock-provider:
    name: mock-provider
    api: openai-completions
    apiKey: MOCK_PROVIDER_API_KEY
    baseUrl: http://127.0.0.1:19988/v1
    models:
      - id: gpt-5.6-luna
        name: gpt-5.6-luna
        reasoning: true
        input: ["text"]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 128000
        maxTokens: 4096
`
  );

  // 2. Create a Global User-Level Rule in both ~/.omp/agent/rules and ~/.omp/rules
  const globalRuleContent = `---
globs: ["src/**/*.ts"]
priority: 5
---
# Global User Style
Enforce strict TypeScript formatting.`;

  await fs.writeFile(path.join(agentRulesDir, "global-code-style.md"), globalRuleContent);
  await fs.writeFile(path.join(homeRulesDir, "global-code-style.md"), globalRuleContent);

  const tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "omp-e2e-proj-"));
  const projRulesDir = path.join(tmpProject, ".omp", "rules");
  await fs.mkdir(projRulesDir, { recursive: true });

  // 3. Project Rule A: API Standard (priority: 50)
  await fs.writeFile(
    path.join(projRulesDir, "api.md"),
    `---
globs: ["src/api/**/*.ts"]
priority: 50
---
# API Standards
Always validate payloads with Zod schemas.`
  );

  // 4. Project Rule B: High-Priority Auth Rule (priority: 100)
  await fs.writeFile(
    path.join(projRulesDir, "auth.md"),
    `---
globs: ["src/auth/**/*.ts", "src/**/Auth*.tsx"]
priority: 100
---
# Auth Security
Never log plaintext tokens or passwords.`
  );

  // 5. Project Rule C: Frontend UI Rule (priority: 40)
  await fs.writeFile(
    path.join(projRulesDir, "ui.md"),
    `---
globs: ["src/components/**/*.tsx", "src/ui/**/*.tsx"]
priority: 40
---
# UI Guidelines
Use Tailwind CSS atomic utility classes.`
  );

  // 6. Project Rule D: TTSR Rule (Must NOT be injected into prompt context)
  await fs.writeFile(
    path.join(projRulesDir, "ttsr-dangerous-eval.md"),
    `---
condition: "eval\\\\("
scope: "tool:edit(*.ts)"
---
# TTSR Stream Alert
Dangerous eval statement detected in stream!`
  );

  const extensionPath = path.resolve("src/index.ts");
  console.log(`==> 2. Real OMP CLI Testing with Extension: ${extensionPath}`);

  const env = {
    ...process.env,
    HOME: tmpHome,
    PI_CODING_AGENT_DIR: agentDir,
    MOCK_PROVIDER_API_KEY: "mock-key",
  };

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: Single Path Matching + Hierarchy (Global User + Project API)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 1: Path matching (src/api/user.ts) ---");
    serverInstance.clearHistory();
    const res1 = await executeOmpTurn(tmpProject, extensionPath, "Please update src/api/user.ts", env);
    if (res1.code !== 0) {
      throw new Error(`Scenario 1 CLI execution failed:\nSTDOUT: ${res1.stdout}\nSTDERR: ${res1.stderr}`);
    }

    const bodies1 = serverInstance.receivedBodies;
    if (bodies1.length === 0) {
      throw new Error("Scenario 1 Failed: Mock server received 0 HTTP requests from OMP CLI");
    }

    const payloadText1 = JSON.stringify(bodies1[0]?.messages);

    // Assert actual rule body content (not just active block tag)
    if (!payloadText1.includes("Always validate payloads with Zod schemas.")) {
      throw new Error(`Scenario 1 Failed: API rule body was not found in HTTP request payload: ${payloadText1}`);
    }
    if (!payloadText1.includes("Enforce strict TypeScript formatting.")) {
      throw new Error(`Scenario 1 Failed: Global user rule was not found in HTTP request payload: ${payloadText1}`);
    }
    console.log("✓ Scenario 1 Passed: HTTP request payload verified to contain Project API rule and Global User rule.");

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Non-matching Path Eviction (Docs turn)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 2: Path eviction on non-matching path (docs/readme.md) ---");
    serverInstance.clearHistory();
    const res2 = await executeOmpTurn(tmpProject, extensionPath, "Please update docs/readme.md", env);
    if (res2.code !== 0) {
      throw new Error(`Scenario 2 CLI execution failed:\nSTDOUT: ${res2.stdout}\nSTDERR: ${res2.stderr}`);
    }

    const bodies2 = serverInstance.receivedBodies;
    if (bodies2.length === 0) {
      throw new Error("Scenario 2 Failed: Mock server received 0 HTTP requests from OMP CLI");
    }

    const payloadText2 = JSON.stringify(bodies2[0]?.messages);

    // Assert actual eviction of rule tags and body contents
    if (payloadText2.includes("<active_path_rules>")) {
      throw new Error(`Scenario 2 Failed: <active_path_rules> was unexpectedly found in non-matching request payload: ${payloadText2}`);
    }
    if (payloadText2.includes("Always validate payloads with Zod schemas.")) {
      throw new Error(`Scenario 2 Failed: API rule body unexpectedly remained in non-matching request payload: ${payloadText2}`);
    }
    if (payloadText2.includes("Enforce strict TypeScript formatting.")) {
      throw new Error(`Scenario 2 Failed: Global TS rule unexpectedly remained in non-matching request payload: ${payloadText2}`);
    }
    console.log("✓ Scenario 2 Passed: HTTP request payload verified to have zero path rules for docs/readme.md.");

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: TTSR Rule Isolation Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 3: TTSR rule isolation from prompt context ---");
    if (payloadText1.includes("Dangerous eval statement detected in stream!")) {
      throw new Error("Scenario 3 Failed: TTSR rule was leaked into prompt request payload!");
    }
    console.log("✓ Scenario 3 Passed: TTSR rule was verified absent from the prompt request payload.");

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: Priority Ordering Across Overlapping Rules
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 4: Priority ordering verification (src/auth/jwt.ts) ---");
    serverInstance.clearHistory();
    const res4 = await executeOmpTurn(tmpProject, extensionPath, "Review token verification in src/auth/jwt.ts", env);
    if (res4.code !== 0) {
      throw new Error(`Scenario 4 CLI execution failed:\nSTDOUT: ${res4.stdout}\nSTDERR: ${res4.stderr}`);
    }

    const bodies4 = serverInstance.receivedBodies;
    if (bodies4.length === 0) {
      throw new Error("Scenario 4 Failed: Mock server received 0 HTTP requests from OMP CLI");
    }

    const payloadText4 = JSON.stringify(bodies4[0]?.messages);
    const authPos = payloadText4.indexOf("Never log plaintext tokens or passwords.");
    const globalPos = payloadText4.indexOf("Enforce strict TypeScript formatting.");

    if (authPos === -1) {
      throw new Error(`Scenario 4 Failed: Auth rule was missing in HTTP request payload: ${payloadText4}`);
    }
    if (globalPos === -1) {
      throw new Error(`Scenario 4 Failed: Global rule was missing in HTTP request payload: ${payloadText4}`);
    }
    if (authPos >= globalPos) {
      throw new Error(`Scenario 4 Failed: Priority 100 Auth rule should appear BEFORE Priority 5 Global rule in HTTP payload. Auth pos: ${authPos}, Global pos: ${globalPos}`);
    }
    console.log("✓ Scenario 4 Passed: Priority 100 rule confirmed strictly positioned before Priority 5 rule in HTTP payload.");

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 5: Multi-Rule Simultaneous Activation
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 5: Multi-Rule Activation (src/components/AuthButton.tsx) ---");
    serverInstance.clearHistory();
    const res5 = await executeOmpTurn(tmpProject, extensionPath, "Edit src/components/AuthButton.tsx", env);
    if (res5.code !== 0) {
      throw new Error(`Scenario 5 CLI execution failed:\nSTDOUT: ${res5.stdout}\nSTDERR: ${res5.stderr}`);
    }

    const bodies5 = serverInstance.receivedBodies;
    if (bodies5.length === 0) {
      throw new Error("Scenario 5 Failed: Mock server received 0 HTTP requests from OMP CLI");
    }

    const payloadText5 = JSON.stringify(bodies5[0]?.messages);

    if (!payloadText5.includes("Use Tailwind CSS atomic utility classes.")) {
      throw new Error(`Scenario 5 Failed: UI rule body was missing in HTTP request payload: ${payloadText5}`);
    }
    if (!payloadText5.includes("Never log plaintext tokens or passwords.")) {
      throw new Error(`Scenario 5 Failed: Auth rule body was missing in HTTP request payload: ${payloadText5}`);
    }
    console.log("✓ Scenario 5 Passed: Multi-pattern simultaneous activation verified in HTTP request payload for AuthButton.tsx.");

    console.log("\n🎉 All Real OMP CLI Linux Dynamic Context HTTP Payload Scenarios Verified Successfully!");
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
  timeoutMs = 25_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>();

  let stdout = "";
  let stderr = "";
  let settled = false;

  const child = spawn(
    "omp",
    [
      "--no-session",
      `--cwd=${cwd}`,
      `--extension=${extensionPath}`,
      "--model=mock-provider/gpt-5.6-luna",
      "-p",
      prompt,
    ],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  // Close child stdin immediately so non-interactive prompt executes without waiting on stdin EOF
  child.stdin.end();

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      child.kill("SIGKILL");
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n[TIMEOUT: omp turn exceeded ${timeoutMs}ms]`,
      });
    }
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    if (!settled) {
      settled = true;
      resolve({ code, stdout, stderr });
    }
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    if (!settled) {
      settled = true;
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    }
  });

  return promise;
}

runRealOmpE2ETest()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("E2E OMP Test Suite Failure:", err);
    process.exit(1);
  });
