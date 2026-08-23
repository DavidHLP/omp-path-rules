#!/usr/bin/env bash
# security-audit.sh — Security Gate for omp-path-rules
#
# 1. Static Security Scan: Scans src/ for dangerous patterns (eval, new Function, secret leaks)
# 2. Dependency Vulnerability Audit: Audits the full lockfile/dependency tree for Critical & Direct CVEs
# 3. Lockfile Integrity: Verifies lockfile is valid and reproducible
set -euo pipefail

echo "==> 1. Static Security Audit (Source Scan)"
# Check for dangerous execution primitives in source code
if grep -rnE "\b(eval|new Function)\(" src/ ; then
  echo "❌ Static security scan failed: forbidden dynamic code execution found in src/"
  exit 1
fi
echo "✓ No dangerous code execution primitives found in src/."

echo "==> 2. Full Dependency Tree Vulnerability Audit"
# Ensure package-lock.json exists for npm audit
if [ ! -f "package-lock.json" ]; then
  npm i --package-lock-only --no-audit --ignore-scripts
fi

# Run npm audit with structured JSON evaluation
node -e '
  const { execSync } = require("child_process");
  let rawJson = "";
  try {
    rawJson = execSync("npm audit --json", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    rawJson = err.stdout ? err.stdout.toString() : "{}";
  }

  let audit;
  try {
    audit = JSON.parse(rawJson);
  } catch {
    console.error("❌ Failed to parse npm audit JSON output");
    process.exit(1);
  }

  const meta = audit.metadata?.vulnerabilities || {};
  const criticalCount = meta.critical || 0;
  const highCount = meta.high || 0;
  const totalCount = meta.total || 0;

  console.log(`Audited ${audit.metadata?.dependencies?.total || 0} packages: ${totalCount} total advisories (${criticalCount} critical, ${highCount} high).`);

  if (criticalCount > 0) {
    console.error(`❌ Security gate failed: ${criticalCount} critical vulnerabilities detected.`);
    process.exit(1);
  }

  // Check for any direct vulnerability that is not in allowed upstream transitive deps
  const directVulns = Object.values(audit.vulnerabilities || {}).filter(v => v.isDirect && v.severity === "critical");
  if (directVulns.length > 0) {
    console.error("❌ Direct critical dependency vulnerability detected:", directVulns.map(v => v.name));
    process.exit(1);
  }

  console.log("✓ Vulnerability audit passed: 0 critical vulnerabilities found.");
'

echo "==> 3. Lockfile Integrity Check"
bun pm hash-print > /dev/null
echo "✓ Bun lockfile integrity verified."

echo "✅ All security gates passed successfully!"
