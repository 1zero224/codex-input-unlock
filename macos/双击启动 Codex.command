#!/bin/bash

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$HOME/Library/Application Support/OpenAI/CodexInputUnlock/codex-input-unlock-macos.sh"

pause_on_error() {
  code="$1"
  echo
  echo '启动失败。请查看上方错误信息。'
  read -r -p '按回车关闭此窗口…' _
  exit "$code"
}

if [[ ! -f "$ENTRY" ]]; then
  echo '首次运行：正在安装启动所需文件…'
  bash "$ROOT/macos/codex-input-unlock-macos.sh" install || pause_on_error "$?"
fi

echo '正在启动 Codex…'
bash "$ENTRY" launch || pause_on_error "$?"
echo '启动完成。'
