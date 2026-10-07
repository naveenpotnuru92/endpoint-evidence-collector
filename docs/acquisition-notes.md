# Acquisition notes, sources & caveats

> **Validation requirement.** Commands and paths below were written from engineering knowledge and have **not** been checked against current primary documentation or target OS builds in this release candidate. The catalog `references` field lists the pages to validate against. Treat each row as *to be verified*.

## Common behaviour
* Hash: SHA-256 of each acquired file at acquisition time (`shasum -a 256`/`sha256sum`, `Get-FileHash`).
* Copies use `cp -p` (preserves mtime/mode/owner where permitted) — this records source metadata but is a copy, not a forensic image.
* Databases: `History`, `places.sqlite`, `History.db` are copied together with `-wal`/`-journal` siblings; **no SQLite API is used**, so the result may be inconsistent if the browser was writing. Marked in `consistencyNote`.
* Applications/browsers are never terminated.

## Windows
| Artifact | Method | Caveat |
|---|---|---|
| Event logs | `wevtutil epl <channel> <dest> /q:<XPath time filter>` (fixed channel allowlist) | Security needs elevation; channels may be disabled (recorded `channel-not-present-or-disabled`) |
| Scheduled tasks | `Get-ScheduledTask` + `Export-ScheduledTask` per task | Non-elevated sessions may not see all tasks |
| Task history | `Microsoft-Windows-TaskScheduler/Operational` export | Usually disabled by default |
| Services | `Win32_Service` via CIM | |
| Registry autoruns | `Get-ItemProperty` on `HKLM` and `HKEY_USERS\<SID>` for **already loaded** hives | Unloaded user hives are reported `user-hive-not-loaded`; the collector does not mount hives |
| Browsers | Shared-read file streams (`FileShare.ReadWrite|Delete`) so locked files can be read | Chromium: `User Data\Default` and `Profile N`; Firefox: `Profiles\*` |
| Profiles | `Win32_UserProfile` (Special ⇒ system); interactive user from `Win32_ComputerSystem.UserName` | Redirected/roaming profiles not specially handled |

## macOS
| Artifact | Method | Caveat |
|---|---|---|
| Unified log | `log show --style ndjson --start/--end --predicate '<fixed>'` with `TZ=UTC` | Root required; bounded predicate, not a logarchive; large output → partial |
| launchd | Copy plists as data from `/Library/Launch{Agents,Daemons}` and per-user `~/Library/LaunchAgents`; listing of `/System/Library/...` | Plists never loaded/parsed |
| Cron/at | `/etc/crontab`, `/usr/lib/cron/tabs`, `/private/var/at/jobs` | Typically root-only; TCC may block |
| Safari | `History.db`, `Downloads.plist` | Requires organization-granted Full Disk Access; collector never grants it or edits TCC |
| Profiles | `dscl . -list /Users UniqueID`; normal = uid ≥ 500, `/Users/*` home, no `_` prefix | Mobile/network accounts not specially handled |
| Interactive user | owner of `/dev/console` | Zero or one only; headless/EDR sessions often yield none |

## Linux
| Artifact | Method | Caveat |
|---|---|---|
| Journal | `journalctl -o export --since/--until` (systemd hosts only) | Persistent journal may be absent; non-systemd hosts skipped |
| Auth / syslog | copy `/var/log/auth.log`, `secure`, `syslog`, `messages` (+ first rotation) | Whole files; no time filtering; distro-dependent paths |
| Cron / timers | `/etc/crontab`, `/etc/cron.*`, `/var/spool/cron`; `systemctl list-timers`; `/etc/systemd/system/*.timer` | |
| Services | `systemctl list-unit-files`, `/etc/init.d` listing, `rc.local`, user systemd/autostart dirs | |
| Browsers | `~/.config/google-chrome`, `chromium`, `BraveSoftware`; `~/.mozilla/firefox` | Snap/Flatpak locations not covered |
| Profiles | `getent passwd`; normal = uid ≥ 1000 with login shell; system = other accounts with an existing home | |
| Interactive user | `who` | Same limitation as above |

## Explicitly out of scope
Cookies, session tokens, saved passwords, key stores, autofill/payment data, SAM/SECURITY hives, LSASS, keychains, credential decryption, disk/memory imaging, deleted-data recovery.

## Fallbacks (partial information only — never a bypass)
When a primary source is unreadable, the collector may use a **normal, permitted** alternative and labels the result `FALLBACK` in the manifest note. The verification report adds an info finding (`fallback-used`). A fallback never reads the same protected file by another route.

| Primary source fails | Fallback | Result |
|---|---|---|
| System crontabs (macOS/Linux, not elevated) | `crontab -l` for the running identity | Own crontab only, or skip `fallback-no-crontab-for-identity` |
| macOS launchd plists unreadable | `launchctl list` (labels + status) | Job names/status only |
| Linux: no `auth.log`/`secure` | `journalctl -t sshd -t sudo -t su` within the time window | Journal entries for those programs only |
| Anything over the per-file limit | none — skipped with size in the reason (`limit:per-file-bytes (N > M)`); raise the limit in the plan | |

Only read-only `crontab -l` is allowed; the static safety test fails the build on any other `crontab` use.
