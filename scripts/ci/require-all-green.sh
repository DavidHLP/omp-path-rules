#!/usr/bin/env bash
# require-all-green.sh — the aggregate gate step: fail unless every needed job
# succeeded (or was legitimately skipped).
#
# Canonical CI step (called by ci.yml ci-ok with RESULTS = toJSON(needs)).
# Venue-parity contract: logic lives in testable script rather than inline YAML.
#
# Usage: RESULTS='<json of the needs context>' scripts/ci/require-all-green.sh
set -euo pipefail

: "${RESULTS:?set RESULTS to the toJSON(needs) context}"

node -e '
  // A skipped job counts as green ONLY with ALLOW_SKIPPED_JOBS=1. Treating
  // skips as success by default is a false-positive channel: any future
  // conditional skip (fork PRs, missing secrets) would keep the gate green
  // while the stage never actually ran.
  const allowSkipped = process.env.ALLOW_SKIPPED_JOBS === "1";
  const needs = JSON.parse(process.env.RESULTS || "{}");
  const bad = {};
  for (const [k, v] of Object.entries(needs)) {
    const ok = v.result === "success" || (allowSkipped && v.result === "skipped");
    if (!ok) bad[k] = v.result;
  }
  if (Object.keys(bad).length > 0) {
    console.error("❌ CI NOT OK:", JSON.stringify(bad, null, 2));
    process.exit(1);
  }
  console.log("✅ CI OK: All stages succeeded" + (allowSkipped ? " (skips allowed)" : "") + ":", Object.keys(needs).join(", "));
'
