#!/bin/bash
set -euo pipefail

ACTION="${1:-diagnose}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="$HOME/Library/Application Support/OpenAI/CodexInputUnlock"
STATE_DIR="$INSTALL_ROOT/state"
LOG_DIR="$INSTALL_ROOT/logs"
STATE_FILE="$STATE_DIR/install-state.json"

die() { printf 'codex-input-unlock: %s\n' "$*" >&2; exit 1; }
node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || die 'Node.js 22 or newer is required.'
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || die "Node.js 22 or newer is required; found $node_major."

find_app() {
  if [[ -n "${CODEX_APP_PATH:-}" ]]; then
    [[ -d "$CODEX_APP_PATH" ]] || die "CODEX_APP_PATH is not an app bundle: $CODEX_APP_PATH"
    printf '%s\n' "$CODEX_APP_PATH"
    return
  fi
  local app
  for app in "/Applications/Codex.app" "$HOME/Applications/Codex.app" \
             "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app"; do
    [[ -d "$app" ]] && { printf '%s\n' "$app"; return; }
  done
  die 'Codex.app or ChatGPT.app was not found. Set CODEX_APP_PATH to its path.'
}

read_state() {
  [[ -f "$STATE_FILE" ]] || die 'Not installed; run this script with install first.'
  "$node_bin" -e 'const s=require(process.argv[1]); process.stdout.write(JSON.stringify(s))' "$STATE_FILE"
}

case "$ACTION" in
  install)
    app="$(find_app)"
    mkdir -p "$STATE_DIR" "$LOG_DIR"
    for file in codex-input-unlock-macos.sh ../cdp-supervisor.mjs ../quota-gate.cjs; do
      source="$ROOT/$file"
      destination="$INSTALL_ROOT/$(basename "$file")"
      [[ "$source" -ef "$destination" ]] || cp "$source" "$destination"
    done
    chmod 700 "$INSTALL_ROOT/codex-input-unlock-macos.sh"
    "$node_bin" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({appPath: process.argv[2]})+"\n")' "$STATE_FILE" "$app"
    touch "$INSTALL_ROOT/.codex-input-unlock-install"
    printf 'Installed at %s\n' "$INSTALL_ROOT"
    ;;
  diagnose)
    app="$(find_app)"
    printf 'App: %s\nNode: %s\n' "$app" "$("$node_bin" --version)"
    if [[ -f "$INSTALL_ROOT/cdp-supervisor.mjs" && -f "$INSTALL_ROOT/quota-gate.cjs" ]]; then
      echo 'Installed: yes'
    else
      echo 'Installed: no (run install)'
    fi
    ;;
  launch)
    state="$(read_state)"
    app="$(printf '%s' "$state" | "$node_bin" -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).appPath')"
    [[ -d "$app" ]] || app="$(find_app)"
    executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)" || die "Cannot read executable from $app"
    app_bin="$app/Contents/MacOS/$executable"
    [[ -x "$app_bin" ]] || die "App executable not found: $app_bin"
    if ps -axo command= | "$node_bin" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(s.includes(process.argv[1]+"/Contents/MacOS/")?0:1))' "$app"; then
      if bash "$0" verify >/dev/null 2>&1; then
        echo 'Codex/ChatGPT is already running with input unlock active.'
        exit 0
      fi
      die 'Codex/ChatGPT is already running. Quit it fully, then launch through this script.'
    fi
    port="$("$node_bin" -e 'require("net").createServer().listen(0,"127.0.0.1",function(){console.log(this.address().port);this.close()})')"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    status="$STATE_DIR/runtime-$stamp.json"
    "$node_bin" "$INSTALL_ROOT/cdp-supervisor.mjs" --port "$port" --gate "$INSTALL_ROOT/quota-gate.cjs" --status "$status" --startup-timeout 60 > "$LOG_DIR/supervisor-$stamp.log" 2>&1 &
    supervisor_pid=$!
    "$app_bin" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" --remote-allow-origins="http://127.0.0.1:$port" >/dev/null 2>&1 &
    app_pid=$!
    ready=false
    on_exit() { if [[ "$ready" != true ]]; then kill "$supervisor_pid" 2>/dev/null || true; fi; }
    trap on_exit EXIT
    deadline=$((SECONDS + 60))
    while (( SECONDS < deadline )); do
      if [[ -f "$status" ]] && "$node_bin" -e 'process.exit(require(process.argv[1]).state === "ready" ? 0 : 1)' "$status"; then break; fi
      if ! kill -0 "$supervisor_pid" 2>/dev/null; then tail -40 "$LOG_DIR/supervisor-$stamp.log" >&2; die 'CDP supervisor exited before becoming ready.'; fi
      sleep 0.25
    done
    [[ -f "$status" ]] && "$node_bin" -e 'process.exit(require(process.argv[1]).state === "ready" ? 0 : 1)' "$status" || die 'Timed out waiting for the Codex renderer and quota gate.'
    "$node_bin" -e 'const fs=require("fs");const p=process.argv[1],s=require(p);s.appPid=Number(process.argv[2]);s.supervisorPid=Number(process.argv[3]);s.debugPort=Number(process.argv[4]);s.lastStatusPath=process.argv[5];fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n")' "$STATE_FILE" "$app_pid" "$supervisor_pid" "$port" "$status"
    ready=true
    trap - EXIT
    echo "Runtime ready (port $port)."
    ;;
  verify)
    state="$(read_state)"
    status="$(printf '%s' "$state" | "$node_bin" -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).lastStatusPath || ""')"
    supervisor_pid="$(printf '%s' "$state" | "$node_bin" -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).supervisorPid || ""')"
    port="$(printf '%s' "$state" | "$node_bin" -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).debugPort || ""')"
    [[ -n "$status" && -f "$status" && "$supervisor_pid" =~ ^[0-9]+$ && "$port" =~ ^[0-9]+$ ]] || die 'No complete launch status found.'
    kill -0 "$supervisor_pid" 2>/dev/null || die 'CDP supervisor is not running.'
    "$node_bin" - "$status" "$port" <<'NODE'
const fs = require("node:fs");
const http = require("node:http");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (status.state !== "ready" || Date.now() - Date.parse(status.updatedAt) > 10000) throw new Error("Runtime status is stale or not ready.");
const request = http.get({ host: "127.0.0.1", port: Number(process.argv[3]), path: "/json", timeout: 2000 }, response => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", chunk => body += chunk);
  response.on("end", () => {
    const targets = JSON.parse(body);
    if (!targets.some(target => target.type === "page" && target.url.startsWith("app://"))) throw new Error("Codex renderer is not responding on CDP.");
    console.log(JSON.stringify(status, null, 2));
  });
});
request.on("timeout", () => request.destroy(new Error("CDP request timed out.")));
request.on("error", error => { console.error(error.message); process.exitCode = 1; });
NODE
    ;;
  uninstall)
    [[ -f "$INSTALL_ROOT/.codex-input-unlock-install" ]] || die "Refusing to remove an unmarked directory: $INSTALL_ROOT"
    if [[ -f "$STATE_FILE" ]]; then
      pid="$("$node_bin" -e 'process.stdout.write(String(require(process.argv[1]).supervisorPid||""))' "$STATE_FILE")"
      if [[ "$pid" =~ ^[0-9]+$ ]] && ps -p "$pid" -o command= | grep -Fq 'cdp-supervisor.mjs'; then kill "$pid"; fi
    fi
    rm -rf "$INSTALL_ROOT"
    echo 'Uninstalled.'
    ;;
  *) die 'Usage: codex-input-unlock-macos.sh {install|diagnose|launch|verify|uninstall}' ;;
esac
