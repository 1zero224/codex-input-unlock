# macOS 使用说明

macOS 入口目前为实验性支持，复用项目现有的 Node.js CDP 监督进程和配额门禁逻辑。需要安装 Node.js 22 或更高版本。

## 双击启动

在 Finder 中双击 `macos/双击启动 Codex.command`。首次运行会自动安装启动文件，然后启动 Codex；之后双击会直接启动。若应用已经通过本入口运行，脚本会验证后提示“已就绪”；若应用是从普通图标启动的，请先完全退出再双击。启动失败时终端窗口会保留错误信息。

## 命令行启动

在仓库根目录运行安装命令：

```bash
bash macos/codex-input-unlock-macos.sh install
```

启动前，请先完全退出 Codex 或 ChatGPT，然后通过专用入口启动：

```bash
bash "$HOME/Library/Application Support/OpenAI/CodexInputUnlock/codex-input-unlock-macos.sh" launch
```

检查运行状态：

```bash
bash "$HOME/Library/Application Support/OpenAI/CodexInputUnlock/codex-input-unlock-macos.sh" verify
```

还可使用 `diagnose` 检查应用和 Node.js 环境，使用 `uninstall` 卸载：

```bash
bash "$HOME/Library/Application Support/OpenAI/CodexInputUnlock/codex-input-unlock-macos.sh" diagnose
bash "$HOME/Library/Application Support/OpenAI/CodexInputUnlock/codex-input-unlock-macos.sh" uninstall
```

默认会查找 `/Applications` 和 `~/Applications` 下的 `Codex.app` 或 `ChatGPT.app`。若应用安装在其他位置，请在安装时指定路径，例如：

```bash
CODEX_APP_PATH="/自定义路径/Codex.app" bash macos/codex-input-unlock-macos.sh install
```

启动器不会修改 `~/.codex/config.toml`、`auth.json` 或官方应用包。卸载只会删除由本工具创建并带有标记的安装目录。

## 限制

必须通过专用入口冷启动应用，renderer 才能接受 CDP 调试连接。配额定位依赖应用内压缩后的 JavaScript；客户端更新可能改变代码结构，导致定位失败。此工具只解除本地输入门禁，不会增加服务端额度，也不会改变 Provider 的鉴权或限流行为。
