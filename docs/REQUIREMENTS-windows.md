# Requirements — Windows

The planner runs on a **Mac**. This page covers the **Windows endpoint** that runs the generated `collector.ps1`.

> **Status: implemented, UNVERIFIED.** The Windows collector has never been executed (no Windows machine was available during development). Test on a disposable endpoint, ordinary and elevated, before relying on it. See [release-checklist.md](release-checklist.md).

## Endpoint requirements (nothing to install)
| Need | Notes |
|---|---|
| Windows 10 / 11 or Server 2016+ (to be validated) | Version matrix is untested |
| Windows PowerShell **5.1** or newer | Built in. Invoked as `powershell.exe -NoProfile -NonInteractive -File collector.ps1 -Run` |
| .NET Framework (built in) | Used for zip packaging (`System.IO.Compression`) |
| Built-in tools/modules | `wevtutil.exe`, CIM cmdlets (`Get-CimInstance`), `ScheduledTasks` and `NetTCPIP` modules |
| Writable local output root | Absolute drive path, e.g. `C:\IR\Evidence`. No UNC/network paths. Free space above the configured reserve |
| Script execution allowed by policy | **Do not** use execution-policy bypass. If policy blocks the script, use your organization's signing/approved deployment route |

## Privileges
| Run as | Sees |
|---|---|
| Ordinary user | Baseline, processes, network, System/Application logs (if permitted), own-profile data |
| Administrator / SYSTEM (elevated) | Adds **Security event log** (requires elevation), all scheduled tasks, all user profiles, HKU hives that are loaded |

The collector detects its identity and records it in the manifest; it never elevates itself. Unloaded user registry hives are reported as unavailable (it does not mount them).

## Commands (from `RUN-INSTRUCTIONS.txt`)
```powershell
Expand-Archive -LiteralPath "C:\Staging\eec-package.zip" -DestinationPath "C:\Staging\eec"
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "C:\Staging\eec\collector.ps1" -PreflightOnly
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "C:\Staging\eec\collector.ps1" -Run
```
Output: `part-001.zip …`, `manifest.json`, `retrieval-index.json`, `status.json`, `FINALIZED` in `<output root>\run-<timestamp>-<id>`.

## Operator side
Collect and verify from the Mac planner (Node ≥ 22). The Verify screen reads `.zip` parts as well as `.tar.gz`.
