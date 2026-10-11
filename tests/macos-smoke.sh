#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
launcher="$repo/macos/codex-input-unlock-macos.sh"
bash -n "$launcher"
bash -n "$repo/macos/双击启动 Codex.command"
node --check "$repo/cdp-supervisor.mjs"
node --check "$repo/quota-gate.cjs"
node - "$repo/quota-gate.cjs" <<'NODE'
const assert = require("node:assert/strict");
const gate = require(process.argv[2]);
assert.equal(gate.condition({ mode: "codex-local-quota", quotaVariable: "quota" }), "(quota=false,false)");
assert.equal(gate.condition({ mode: "codex-local-quota", quotaVariable: "bad-name" }), null);
NODE
echo 'macOS static smoke checks passed'
