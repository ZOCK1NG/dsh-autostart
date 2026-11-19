# DSH Autostart

![DSH autostart keeps the main window in the system tray](docs/preview.svg)

Starts DeepSeek Harness silently in the system tray when you sign in to Windows, and gives the agent tools to manage that login item.

> Unofficial community plugin. Not affiliated with DeepSeek. Windows only.

## Install

This is a local DSH bundle, not an npm package:

1. Clone or download this repository to a stable folder. The bundle is linked into your DSH profile, so don't move or delete the folder after installing.
2. Install it as a local bundle — either ask the DSH agent to run `plugin_manager install_bundle` with this folder's absolute path, or use **Settings → Plugins → Add plugin** with the same folder.
3. Ask the agent to run `autostart_enable` (for example: "enable DSH autostart"). It deploys the launcher into `%LOCALAPPDATA%\DSH`, writes the Startup-folder shortcut and verifies the chain.

`autostart_disable` turns the login item off again; the plugin itself can be removed from the profile afterwards.

## What it installs

`autostart_enable` deploys two files into `%LOCALAPPDATA%\DSH` and creates one shortcut in the Windows Startup folder:

| Path | Role |
| --- | --- |
| `%LOCALAPPDATA%\DSH\dsh-tray-start.ps1` | Launcher: starts DeepSeek Harness and hides its primary window so the app stays in the tray |
| `%LOCALAPPDATA%\DSH\dsh-tray-start.vbs` | Signed-host wrapper: `wscript.exe` starts the launcher through a hidden `powershell.exe` |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DeepSeek Harness.lnk` | Startup-folder shortcut: `wscript.exe //B //Nologo "...\dsh-tray-start.vbs"` |

The shortcut is the on/off switch: `autostart_disable` removes it (and its `StartupApproved` entry) and keeps the launcher files for a later re-enable.

## Why this chain instead of an exe

DeepSeek Harness has no built-in "start at login" setting, and this machine runs **Smart App Control** in enforcement mode (`VerifiedAndReputablePolicyState = 1`). Smart App Control blocks unsigned executables at sign-in (CodeIntegrity events 3077/3033) — the previous custom `DSH-TrayStart.exe` was blocked every login and DSH never started.

The chain above only uses Microsoft-signed hosts: `wscript.exe` (signature valid) launches a hidden `powershell.exe` (signature valid), which compiles the small window-hider with `Add-Type` in memory and starts `DeepSeek Harness.exe` (signed by Hangzhou DeepSeek Artificial Intelligence Co., Ltd.). Nothing unsigned is executed, so Smart App Control allows the whole chain.

## Tools

| Tool | What it does |
| --- | --- |
| `autostart_status` | Read-only report: shortcut, target/arguments, startup approval, launcher files, Smart App Control, last launcher log lines |
| `autostart_enable` | Deploys the launcher, writes the Startup shortcut, marks it approved, then runs the chain once in guard mode |
| `autostart_disable` | Removes the Startup shortcut and its approval entry |
| `autostart_verify` | Runs six end-to-end checks, including a live guard-mode run of `wscript -> PowerShell -> Add-Type` in a temporary `LOCALAPPDATA` |

## Behaviour

- At sign-in the app starts hidden and lands in the tray after the window-hider grace period (4 s); the tray icon and the app itself behave as usual afterwards.
- If DSH is already running, the launcher logs `app already running; nothing to do` and exits.
- Every launcher run appends to `%LOCALAPPDATA%\DSH\tray-start.log`, so autostart failures can be diagnosed from that file.
- `autostart_verify` runs the chain with a temporary `LOCALAPPDATA`; it never touches the installed log or a running DSH window.

## Limitations

- Windows only (this plugin manages a Windows login item).
- The plugin installs/repairs the login item from inside DSH; it cannot start before DSH. The tray-hiding step runs only on the sign-in launch.
- No settings/window UI: management happens through the four agent tools (e.g. ask "enable DSH autostart").

## Files

```
index.js                  tool definitions
lib/autostart.js          shortcut/approval/launcher logic (node: builtins only)
payload/dsh-tray-start.ps1  launcher template (exe path injected at deploy time)
payload/dsh-tray-start.vbs  signed-host wrapper
locale/{en,zh}.json       plugin page metadata
docs/DETAIL.md + preview.svg  plugin page details
```

## License

MIT. See [LICENSE](LICENSE).
