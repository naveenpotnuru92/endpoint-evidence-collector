# Support matrix

**State legend** — *planned*: no collector (package generation refuses it). *implemented-unverified*: collector code exists and is covered by synthetic tests, but has **not** been validated on target OS builds or via the EDR. *verified*: validated on target builds + EDR (**none yet**).

## What was actually executed so far
| Collector | Executed? | Where | Evidence |
|---|---|---|---|
| macOS (`collector.sh` + macos artifacts) | **Yes, partially** | macOS 27.0 dev machine, synthetic fixture profiles, ordinary privileges only | `tests/e2e.test.ts`, `npm run smoke`. Unified-log (needs root), Safari (needs Full Disk Access) and the real `/Users` discovery path via `dscl` were **not** exercised end to end under test. |
| Linux (`collector.sh` + linux artifacts) | **No** | `bash -n` syntax check and static-safety tests only | Needs a disposable Linux VM per distro. Same Unix core was exercised on macOS. |
| Windows (`collector.ps1`) | **No** | Not executed anywhere (no Windows/PowerShell available). Static review + forbidden-pattern tests only | Needs a disposable Windows endpoint, ordinary + elevated. |
| EDR hand-off | **No** | — | Separate acceptance test with your EDR. |

## Per-category coverage (catalog 0.1.0)
| Category | Windows | macOS | Linux | Time filter | Notes |
|---|---|---|---|---|---|
| System baseline | unverified | unverified | unverified | n/a | OS/version/uptime/identity/elevation |
| Volatile: processes | unverified | unverified | unverified | n/a | No arguments by default |
| Volatile: command lines (**sensitive option**) | unverified | unverified | unverified | n/a | Needs explicit `process-command-lines`; never in presets / "select all" |
| Volatile: network | unverified | unverified | unverified | n/a | Non-root sees fewer sockets / PIDs |
| Event / system / security logs | unverified (evtx via `wevtutil`) | unverified (`log show`, `/var/log`) | unverified (journal, auth, syslog) | native for evtx, unified log, journal; **none** for file logs | Security log, unified log and auth logs need elevation |
| Scheduled execution | tasks + history | cron + launchd | cron + systemd timers | history native | Different mechanisms per OS; preview names them |
| Services & startup | services, startup folders | launchctl list, StartupItems | systemd unit files, init.d, rc.local, autostart | n/a | Metadata mostly; plist/unit files copied as-is |
| Registry | Run/RunOnce, Services (loaded hives only) | — | — | n/a | **Broad hive export: planned only** |
| Browsers: history/downloads | Chrome, Edge, Brave, Firefox | Safari*, Chrome, Edge, Brave, Firefox | Chrome/Chromium, Brave, Firefox | none | *Safari needs org-granted Full Disk Access. Snap/Flatpak paths not covered |
| Browsers: extensions/preferences | Chromium family, Firefox | Chromium family, Firefox | *(not implemented)* | none | Cookies/passwords/autofill **never** |
| User & app logs | CBS/setupapi | `~/Library/Logs` | `.xsession-errors`, `.local/state/*.log` | none | |
| Custom files | yes | yes | yes | none | Literal paths; symlinks not followed |

## Target OS versions
Untested everywhere. Candidate matrix to validate (extend with your fleet): Windows 10 22H2, Windows 11 23H2/24H2, Windows Server 2019/2022; macOS 13–15 (and the dev-machine version); Ubuntu 22.04/24.04, Debian 12, RHEL/Rocky 9. Until tested, treat none as supported.

## Privilege behaviour
Each artifact declares `none`, `elevated-recommended`, or `elevated-required`. The collector detects its identity and records `elevated` in the manifest; it never elevates. Failures due to missing privilege are recorded per artifact (outcome `failed`, error `Permission denied` / `requires elevation`).
