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

const currentCodexBundle = [
  "XP=Xl(K,({get:e})=>{let t=e(Ey),n=e(ly).data;if(t.authMethod!==`chatgpt`||n.rate_limit?.allowed!==!1)return!1;return!0})",
  "vn=X(bt===`local`&&XP),",
  "let Zn=De||gn||vn,Qn;",
  "submitDisabled:Zn",
].join("");
const location = gate.locate(currentCodexBundle, "app://-/assets/app-primary-current.js");
assert.equal(location?.mode, "codex-local-quota");
assert.equal(location?.quotaVariable, "vn");
assert.equal(location?.hostVariable, "bt");
assert.equal(gate.condition(location), "(vn=false,false)");

const previousCodexBundle = currentCodexBundle.replace(
  "vn=X(bt===`local`&&XP),",
  "vn=X(XP)&&bt===`local`,",
);
const previousLocation = gate.locate(previousCodexBundle, "app://-/assets/app-primary-previous.js");
assert.equal(previousLocation?.mode, "codex-local-quota");
NODE
echo 'macOS static smoke checks passed'
