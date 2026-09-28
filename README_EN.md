# Codex Input Unlock (`codex-input-unlock`)

English | [简体中文](README.md)

An **external runtime input unlocker** for the official Codex Desktop and ChatGPT Desktop applications on Windows.

When a user has configured a **third-party API provider, relay, or self-hosted gateway**, the official desktop client may still disable the composer and send button if the signed-in official account has exhausted its quota. Codex Input Unlock uses Chrome DevTools Protocol (CDP) to install a dynamic, non-pausing conditional breakpoint that **removes this local frontend input and send gate**.

> [!IMPORTANT]
> **Scope and disclaimer:**
> This project does **not and cannot** bypass, restore, or increase an OpenAI account's official quota. Its only purpose is to remove an unnecessary local frontend gate when you are already using **your own third-party API key and provider**.

---

## Features

- 🛡️ **No package modification:** Does not modify the Store Appx package, ASAR archive, or executable files. The official package and its signature remain untouched.
- 🔒 **No configuration management:** Never modifies, overwrites, or synchronizes `~/.codex/config.toml` or `auth.json`. You remain responsible for your own configuration.
- ⚡ **Non-pausing conditional breakpoint:** Uses a JavaScript comma expression such as `(quota = false, false)` to update the local variable while the breakpoint condition always evaluates to false, so the page never pauses.
- 🔄 **Automatic recovery after reload:** Watches the renderer lifecycle and reinstalls the breakpoint after a page reload or `Ctrl + R`.

---

## How it works

```text
PowerShell controller (codex-input-unlock.ps1)
  ├─ Finds the official Store package (Codex / ChatGPT Desktop)
  ├─ Allocates a random TCP port and starts the Node.js CDP supervisor
  └─ Activates the client through COM with remote-debugging arguments
                        │
                        ▼
CDP supervisor (cdp-supervisor.mjs + quota-gate.cjs)
  ├─ Connects to the client renderer through CDP
  ├─ Locates the quota gate in the frontend JavaScript bundle
  ├─ Installs a conditional breakpoint: (quota = false, false)
  │    └─ Clears the local gate without pausing the renderer
  └─ Reinstalls the injection after a page reload or Ctrl + R
```

---

## Requirements

- **Operating system:** Windows 10 or Windows 11 (x64 / ARM64)
- **Official client:** Microsoft Store version of Codex Desktop or ChatGPT Desktop
- **Runtime dependencies:** PowerShell 7+ (`pwsh`) and Node.js 22+

---

## Quick start

### Configure your provider first

Before launching Codex Input Unlock, configure and verify your third-party provider in `~/.codex/config.toml`. This project does not create, modify, or validate provider configuration for you.

If you want to retain your official Codex account login while using the third-party provider, set the following option in the corresponding provider configuration:

```toml
requires_openai_auth = true
```

You must also sign in to your Codex account in Codex Desktop before using the unlocker. The third-party provider, `requires_openai_auth = true`, and the Codex login state must already be configured. Codex Input Unlock only removes the local input and send gate caused by the official quota state; it does not replace provider setup or account login.

### 1. Install

Open PowerShell 7 in the source directory and run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File '.\codex-input-unlock.ps1' -Action Install
```

Installation copies the required runtime files to `%LOCALAPPDATA%\OpenAI\CodexInputUnlock` and creates a **Codex Input Unlock** shortcut in the Windows Start menu.

### 2. Launch

> **Important:** Completely quit every running Codex Desktop or ChatGPT Desktop process before launching, including the system tray application. If either client is still running, the launcher will not terminate it. Instead, it displays an English error with the matching process information and keeps the shortcut window open until you press Enter.

- **Option A (recommended):** Open the Start menu and select **Codex Input Unlock**.
- **Option B (command line):**

  ```powershell
  pwsh -NoProfile -ExecutionPolicy Bypass `
    -File "$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1" `
    -Action Launch
  ```

Launching from the original official shortcut does not include the required debugging arguments and therefore does not load the unlocker.

### 3. Verify

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1" `
  -Action Verify
```

`RuntimeReady : True` means that the supervisor is alive, CDP is connected, and the breakpoint has been installed.

---

## Commands

The installed entry script is located at:

`$env:LOCALAPPDATA\OpenAI\CodexInputUnlock\codex-input-unlock.ps1`

| Action | Description |
| :--- | :--- |
| `-Action Diagnose` | Checks runtime dependencies, the installed Store package, and required runtime files |
| `-Action Verify` | Checks the supervisor process, CDP connection, and breakpoint readiness |
| `-Action Inspect` | Prints detailed diagnostic JSON containing the listener, process, and recent logs |
| `-Action Uninstall` | Stops the supervisor and removes the shortcut and runtime directory without touching user configuration or the official package |

Common parameters:

- `-NoShortcut`: Do not create a Start menu shortcut during installation.
- `-DisableComputerUseBootstrap`: Do not write the Computer Use environment variable.
- `-StartupTimeoutSeconds <seconds>`: Changes the startup timeout from the default of 60 seconds.

---

## Testing

```powershell
# Full static smoke test, including the configuration non-modification check
pwsh -NoProfile -ExecutionPolicy Bypass -File '.\tests\smoke.ps1'

# CI-friendly static test without requiring an installed Store package
pwsh -NoProfile -ExecutionPolicy Bypass -File '.\tests\smoke.ps1' -SkipPackageCheck
```

---

## Notes

1. **A cold start through the dedicated launcher is required.** The original official shortcut does not provide the CDP arguments.
2. **Only the local input gate is affected.** This tool does not fabricate server-side quota. Usage, authentication, and rate limits are controlled by your third-party provider.
3. **Unofficial project:** This project is independent and is not affiliated with OpenAI.

---

## License

[MIT](LICENSE)
