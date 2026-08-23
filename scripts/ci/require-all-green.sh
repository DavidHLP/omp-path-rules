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
  const needs = JSON.parse(process.env.RESULTS || "{}");
  const bad = {};
  for (const [k, v] of Object.entries(needs)) {
    if (v.result !== "success" && v.result !== "skipped") {
      bad[k] = v.result;
    }
  }
  if (Object.keys(bad).length > 0) {
    console.error("❌ CI NOT OK:", JSON.stringify(bad, null, 2));
    process.exit(1);
  }
  console.log("✅ CI OK: All stages succeeded or legitimately skipped:", Object.keys(needs).join(", "));
'
