import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { startMockOpenAiServer } from "./mock-llm-server.js";

async function runRealOmpE2ETest(): Promise<void> {
  console.log("==> 1. Initializing Mock OpenAI LLM Server on 127.0.0.1:19988...");
  const serverInstance = await startMockOpenAiServer(19988);

  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-e2e-home-"));
  const dotOmpDir = path.join(tmpHome, ".omp");
  const agentDir = path.join(dotOmpDir, "agent");
  const agentRulesDir = path.join(agentDir, "rules");
  const homeRulesDir = path.join(dotOmpDir, "rules");
  await fs.mkdir(dotOmpDir, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(agentRulesDir, { recursive: true });
  await fs.mkdir(homeRulesDir, { recursive: true });

  // 1. Configure user-level models.yml with full OMP schema compliance
  const modelsYmlContent = `providers:
  mock-openai:
    id: mock-openai
    name: Mock OpenAI Provider
    api: openai-completions
    baseUrl: http://127.0.0.1:19988/v1
    apiKey: mock-key
    models:
      - id: mock-model
        name: Mock Fast Model
        contextWindow: 128000
        maxTokens: 4096
        supportsTools: true
`;

  await fs.writeFile(path.join(agentDir, "models.yml"), modelsYmlContent);
  await fs.writeFile(path.join(dotOmpDir, "models.yml"), modelsYmlContent);

  // 2. Create a Global User-Level Rule in both ~/.omp/agent/rules and ~/.omp/rules
  const globalRuleContent = `---
priority: 5
globs:
  - "**/*.ts"
  - "**/*.tsx"
---
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
priority: 50
globs:
  - "src/api/**/*.ts"
---
Always validate payloads with Zod schemas.`
  );

  // 4. Project Rule B: High-Priority Auth Rule (priority: 100)
  await fs.writeFile(
    path.join(projRulesDir, "auth.md"),
    `---
priority: 100
globs:
  - "src/auth/**/*.ts"
  - "src/components/Auth*.tsx"
---
Never log plaintext tokens or passwords.`
  );

  // 5. Project Rule C: Frontend UI Rule (priority: 40)
  await fs.writeFile(
    path.join(projRulesDir, "ui.md"),
    `---
priority: 40
globs:
  - "src/components/**/*.tsx"
---
Use Tailwind CSS atomic utility classes.`
  );

  // 6. Project Rule D: TTSR Rule (Must NOT be injected into prompt context)
  await fs.writeFile(
    path.join(projRulesDir, "ttsr-dangerous-eval.md"),
    `---
condition: "eval\\("
alwaysApply: false
---
Dangerous eval statement detected in stream!`
  );

  const extensionPath = path.resolve("src/index.ts");
  console.log(`==> 2. Real OMP CLI Testing with Extension: ${extensionPath}`);

  const env = {
    ...process.env,
    HOME: tmpHome,
    PI_CODING_AGENT_DIR: agentDir,
  };

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: Single Path Matching + Hierarchy (Global User + Project API)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 1: Path matching (src/api/user.ts) ---");
    serverInstance.clearHistory();
    const res1 = await executeOmpTurn(tmpProject, extensionPath, "Please update src/api/user.ts", env);
    if (res1.code !== 0) {
      throw new Error(`Scenario 1 CLI execution failed with exit code ${res1.code}:\nSTDOUT: ${res1.stdout}\nSTDERR: ${res1.stderr}`);
    }

    const bodies1 = serverInstance.receivedBodies;
    if (bodies1.length === 0 || !Array.isArray(bodies1[0]?.messages) || bodies1[0].messages.length === 0) {
      throw new Error("Scenario 1 Failed: Mock server received 0 valid HTTP requests with messages from OMP CLI");
    }

    const payloadText1 = JSON.stringify(bodies1[0].messages);

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
      throw new Error(`Scenario 2 CLI execution failed with exit code ${res2.code}:\nSTDOUT: ${res2.stdout}\nSTDERR: ${res2.stderr}`);
    }

    const bodies2 = serverInstance.receivedBodies;
    if (bodies2.length === 0 || !Array.isArray(bodies2[0]?.messages) || bodies2[0].messages.length === 0) {
      throw new Error("Scenario 2 Failed: Mock server received 0 valid HTTP requests with messages from OMP CLI");
    }

    const payloadText2 = JSON.stringify(bodies2[0].messages);

    // Verify the prompt was indeed transmitted by OMP
    if (!payloadText2.includes("docs/readme.md")) {
      throw new Error(`Scenario 2 Failed: User prompt was missing in HTTP request payload: ${payloadText2}`);
    }

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
    // SCENARIO 3: TTSR Rule Isolation (Dedicated CLI Turn)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 3: TTSR rule isolation on dedicated turn (src/eval/runner.ts) ---");
    serverInstance.clearHistory();
    const res3 = await executeOmpTurn(tmpProject, extensionPath, "Evaluate script execution in src/eval/runner.ts", env);
    if (res3.code !== 0) {
      throw new Error(`Scenario 3 CLI execution failed with exit code ${res3.code}:\nSTDOUT: ${res3.stdout}\nSTDERR: ${res3.stderr}`);
    }

    const bodies3 = serverInstance.receivedBodies;
    if (bodies3.length === 0 || !Array.isArray(bodies3[0]?.messages) || bodies3[0].messages.length === 0) {
      throw new Error("Scenario 3 Failed: Mock server received 0 valid HTTP requests with messages from OMP CLI");
    }

    const payloadText3 = JSON.stringify(bodies3[0].messages);

    // Verify the prompt was transmitted by OMP
    if (!payloadText3.includes("src/eval/runner.ts")) {
      throw new Error(`Scenario 3 Failed: User prompt was missing in HTTP request payload: ${payloadText3}`);
    }

    // Assert TTSR stream rule content is NOT leaked into prompt context
    if (payloadText3.includes("Dangerous eval statement detected in stream!")) {
      throw new Error(`Scenario 3 Failed: TTSR rule body was unexpectedly leaked into prompt request payload: ${payloadText3}`);
    }
    if (payloadText3.includes("ttsr-dangerous-eval")) {
      throw new Error(`Scenario 3 Failed: TTSR rule ID was unexpectedly leaked into prompt request payload: ${payloadText3}`);
    }
    console.log("✓ Scenario 3 Passed: Dedicated CLI turn executed (code 0) and verified TTSR rule strictly excluded from HTTP payload.");

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: Priority Ordering Across Overlapping Rules
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n--- Scenario 4: Priority ordering verification (src/auth/jwt.ts) ---");
    serverInstance.clearHistory();
    const res4 = await executeOmpTurn(tmpProject, extensionPath, "Review token verification in src/auth/jwt.ts", env);
    if (res4.code !== 0) {
      throw new Error(`Scenario 4 CLI execution failed with exit code ${res4.code}:\nSTDOUT: ${res4.stdout}\nSTDERR: ${res4.stderr}`);
    }

    const bodies4 = serverInstance.receivedBodies;
    if (bodies4.length === 0 || !Array.isArray(bodies4[0]?.messages) || bodies4[0].messages.length === 0) {
      throw new Error("Scenario 4 Failed: Mock server received 0 valid HTTP requests with messages from OMP CLI");
    }

    const payloadText4 = JSON.stringify(bodies4[0].messages);
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
      throw new Error(`Scenario 5 CLI execution failed with exit code ${res5.code}:\nSTDOUT: ${res5.stdout}\nSTDERR: ${res5.stderr}`);
    }

    const bodies5 = serverInstance.receivedBodies;
    if (bodies5.length === 0 || !Array.isArray(bodies5[0]?.messages) || bodies5[0].messages.length === 0) {
      throw new Error("Scenario 5 Failed: Mock server received 0 valid HTTP requests with messages from OMP CLI");
    }

    const payloadText5 = JSON.stringify(bodies5[0].messages);

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
  let resolve: (res: { code: number | null; stdout: string; stderr: string }) => void;
  const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => {
    resolve = r;
  });

  let stdout = "";
  let stderr = "";

  const child = spawn(
    "omp",
    [
      "-p",
      prompt,
      "--no-extensions",
      "-e",
      extensionPath,
      "--provider",
      "mock-openai",
      "--model",
      "mock-model",
    ],
    {
      cwd,
      env: {
        ...env,
        CI: "true",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        TERM: "dumb",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  let finished = false;
  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      child.kill("SIGKILL");
      resolve({ code: -1, stdout, stderr: stderr + "\n[Execution Timed Out]" });
    }
  }, timeoutMs);

  child.on("close", (code) => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    }
  });

  child.on("error", (err) => {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[Spawn Error: ${err.message}]` });
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
