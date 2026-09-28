# Codex Input Unlock (`codex-input-unlock`)

[English](README_EN.md) | 简体中文

针对 Windows 官方 Codex Desktop / ChatGPT Desktop 的**外部运行时输入解锁工具**。

当用户在客户端中配置了**第三方 API Provider**，且登录的官方账号没有额度时，官方客户端前端会强行将输入框与发送按钮置灰锁定。本项目通过 Chrome DevTools Protocol (CDP) 注入动态零暂停条件断点，**解除本地前端对输入框与发送动作的封锁**。

---

## 工作原理

```text
PowerShell 控制器 (codex-input-unlock.ps1)
  ├─ 识别官方 Store 包 (Codex / ChatGPT Desktop)
  ├─ 分配随机 TCP 端口冷启动 Node.js CDP 守护进程
  └─ 通过 COM 激活带调试参数的客户端
                        │
                        ▼
CDP 守护进程 (cdp-supervisor.mjs + quota-gate.cjs)
  ├─ 连接客户端 Renderer 调试端口
  ├─ 模式匹配定位前端 JS bundle 中的配额校验逻辑
  ├─ 安装条件断点：(quota = false, false)
  │    └─ 静默重置本地变量，条件恒为 false 永不挂起页面
  └─ 遇到页面刷新 (Ctrl+R) 自动重新注入
```

---

## 环境要求

- **操作系统**：Windows 10 / 11 (x64 / ARM64)
- **官方客户端**：Microsoft Store 版 Codex Desktop 或 ChatGPT Desktop
- **运行依赖**：PowerShell 7+ (`pwsh`) 与 Node.js 22+

---

## 快速上手

### 使用前配置

启动 Codex Input Unlock 前，请先在 `~/.codex/config.toml` 中配置并确认您的第三方 Provider 可以正常使用。本项目不会代您创建、修改或校验 Provider 配置。

如果您希望在使用第三方 Provider 的同时保留 Codex 官方账号的登录状态（例如继续使用依赖登录状态的功能），请在对应 Provider 配置中设置：

```toml
requires_openai_auth = true
```

同时请先在 Codex Desktop 中登录您的 Codex 账号。只有第三方 Provider、`requires_openai_auth = true` 和 Codex 登录状态均已准备好后，本工具才负责解除官方额度状态造成的本地输入与发送门禁；它不会替代 Provider 配置或账号登录。

### 1. 安装

在源码目录下打开 PowerShell 7 并执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File '.\codex-input-unlock.ps1' -Action Install
```

*安装会将必要运行文件复制至 `%LOCALAPPDATA%\OpenAI\CodexInputUnlock`，并在 Windows 开始菜单生成 **`Codex Input Unlock`** 快捷方式。*

### 2. 启动

> **注意**：启动前请**完全退出**正在运行的 Codex Desktop 或 ChatGPT Desktop（包括系统托盘图标）。如果检测到任一客户端仍在运行，启动器不会关闭它，而会保留错误窗口并显示对应进程信息。

- **方式 A（推荐）**：打开开始菜单，直接点击 **`Codex Input Unlock`**。
- **方式 B（命令行）**：
  ```powershell
  pwsh -NoProfile -ExecutionPolicy Bypass `
    -File "$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1" `
    -Action Launch
  ```

*注：直接点击官方原生图标启动不带调试参数，不会加载解锁逻辑。*

### 3. 验证状态

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1" `
  -Action Verify
```

输出中 `RuntimeReady : True` 即表示守护进程正常运行、断点已挂载，输入框已解除封锁。

---

## 常用命令

入口脚本统一位于：`$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1`

| Action | 说明 |
| :--- | :--- |
| `-Action Diagnose` | 诊断环境依赖、已安装包状态与文件完整性 |
| `-Action Verify` | 检查守护进程存活、CDP 连通性与断点就绪状态 |
| `-Action Inspect` | 输出包含网络监听、进程树与最近日志的详细诊断 JSON |
| `-Action Uninstall` | 停止守护进程、移除快捷方式与运行目录（不影响用户配置与官方包） |

**常用参数**：
- `-NoShortcut`：安装时不创建开始菜单快捷方式
- `-DisableComputerUseBootstrap`：不写入 Computer Use 环境变量
- `-StartupTimeoutSeconds <秒数>`：自定义启动超时等待（默认 60s）

---

## 测试

```powershell
# 完整静态冒烟测试（含配置防篡改校验）
pwsh -NoProfile -ExecutionPolicy Bypass -File '.\tests\smoke.ps1'

# 无 Store 客户端的 CI 纯静态测试
pwsh -NoProfile -ExecutionPolicy Bypass -File '.\tests\smoke.ps1' -SkipPackageCheck
```

---

## 注意事项

1. **必须通过专属入口冷启动**：官方原版快捷方式启动的进程不带 CDP 参数。
2. **仅解决本地输入框锁定**：本工具不伪造服务端 API 额度；第三方 API 的调用消耗、鉴权和限流由您配置的 Provider 自行处理。
3. **免责声明**：本项目为独立的非官方开源工具，与 OpenAI 无任何隶属关系。

---

## License

[MIT](LICENSE)


[LINUX DO](https://linux.do)
