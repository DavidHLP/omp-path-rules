#!/usr/bin/env bash
# security-audit.sh — Security Gate for omp-path-rules
#
# 1. Static Security Scan: comment-stripped scan of src/ for dynamic code execution
# 2. Dependency Vulnerability Audit: critical AND high severities, with an explicit,
#    expiring allowlist (scripts/ci/security-allowlist.json) for accepted risks
# 3. Lockfile Parity: package-lock.json (audited tree) must be in sync with package.json,
#    so npm audit never evaluates a dependency tree different from the bun-installed one
# 4. Lockfile Integrity: bun lockfile parses and hashes cleanly
set -euo pipefail

echo "==> 1. Static Security Audit (comment-stripped source scan)"
# Strip comments before scanning so prose like "avoid eval(...)" in comments
# cannot fail the gate, while real call sites still do.
node -e '
  const fs = require("fs");
  const path = require("path");
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const forbidden = [/\beval\s*\(/, /\bnew\s+Function\s*\(/];
  const hits = [];
  for (const f of walk("src")) {
    let src = fs.readFileSync(f, "utf8");
    src = src.replace(/\/\*[\s\S]*?\*\//g, "");          // block comments
    src = src.replace(/(^|[^:"`])\/\/[^\n]*/g, "$1");        // line comments (not inside URLs)
    for (const re of forbidden) {
      if (re.test(src)) hits.push(`${f}: matches /${re.source}/`);
    }
  }
  if (hits.length > 0) {
    console.error("❌ Static security scan failed: forbidden dynamic code execution found in src/:");
    for (const h of hits) console.error("   " + h);
    process.exit(1);
  }
  console.log("✓ No dangerous code execution primitives found in src/.");
'

echo "==> 2. Full Dependency Tree Vulnerability Audit"
# Ensure package-lock.json exists for npm audit
if [ ! -f "package-lock.json" ]; then
  npm i --package-lock-only --no-audit --ignore-scripts
fi

node -e '
  const fs = require("fs");
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

  // Explicit, expiring allowlist for accepted high-severity risks.
  let allowlist = { entries: [] };
  try {
    allowlist = JSON.parse(fs.readFileSync("scripts/ci/security-allowlist.json", "utf8"));
  } catch (e) {
    console.error("❌ Cannot read scripts/ci/security-allowlist.json:", e.message);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Expired allowlist entries force a re-review instead of silently extending.
  const expired = (allowlist.entries || []).filter((e) => e.expires && e.expires < today);
  if (expired.length > 0) {
    console.error("❌ Security allowlist entries have EXPIRED — re-review or remove them:");
    for (const e of expired) console.error(`   ${e.name} (expired ${e.expires}): ${e.reason}`);
    process.exit(1);
  }

  const allowedNames = new Set((allowlist.entries || []).map((e) => e.name));

  if (criticalCount > 0) {
    const unallowedCritical = Object.values(audit.vulnerabilities || {})
      .filter((v) => v.severity === "critical" && !allowedNames.has(v.name));
    if (unallowedCritical.length > 0) {
      console.error("❌ Security gate failed: unallowed critical vulnerabilities detected:",
        unallowedCritical.map((v) => v.name));
      process.exit(1);
    }
    console.log("⚠ Critical advisories present but covered by allowlist entries.");
  }

  const highs = Object.values(audit.vulnerabilities || {}).filter((v) => v.severity === "high");
  const unallowedHighs = highs.filter((v) => !allowedNames.has(v.name));
  if (unallowedHighs.length > 0) {
    console.error("❌ Security gate failed: high-severity vulnerabilities not covered by scripts/ci/security-allowlist.json:");
    for (const v of unallowedHighs) {
      console.error(`   ${v.name} (direct: ${v.isDirect}, range: ${v.range})`);
    }
    console.error("   Fix them or add a justified, expiring allowlist entry.");
    process.exit(1);
  }

  console.log(`✓ Vulnerability audit passed: 0 critical; ${highs.length} high advisory(ies), all covered by expiring allowlist entries.`);
'

echo "==> 3. Lockfile Parity Check (package-lock.json vs package.json)"
# The security audit runs against package-lock.json while installs use bun.lock.
# If package-lock.json drifts from package.json, npm audit evaluates the WRONG tree.
LOCKFILE_BACKUP="$(mktemp)"
cp package-lock.json "$LOCKFILE_BACKUP"
PARITY_OK=0
if npm i --package-lock-only --no-audit --ignore-scripts >/dev/null 2>&1 && diff -q "$LOCKFILE_BACKUP" package-lock.json >/dev/null 2>&1; then
  PARITY_OK=1
fi
# Always restore the committed lockfile so the workspace stays clean.
cp "$LOCKFILE_BACKUP" package-lock.json
rm -f "$LOCKFILE_BACKUP"
if [ "$PARITY_OK" -ne 1 ]; then
  echo "❌ Lockfile parity check failed: package-lock.json is out of sync with package.json."
  echo "   Run: npm i --package-lock-only --no-audit --ignore-scripts && git add package-lock.json"
  exit 1
fi
echo "✓ package-lock.json is in sync with package.json."

echo "==> 4. Lockfile Integrity Check"
bun pm hash-print > /dev/null
echo "✓ Bun lockfile integrity verified."

echo "✅ All security gates passed successfully!"
