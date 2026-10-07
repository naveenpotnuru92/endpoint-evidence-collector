# Requirements — macOS

Two roles: the **operator Mac** (runs the planner) and a **macOS endpoint** (runs the generated `collector.sh`). They can be the same machine for testing.

## A. Operator Mac (planner)
| Need | Check | Notes |
|---|---|---|
| Node.js ≥ 22 and npm | `node -v` | Dev launcher: `npm install && npm run app` |
| A web browser | — | UI at `http://127.0.0.1:<port>/` (loopback only) |
| Google Chrome in `/Applications` | optional | Only for `npm run test:e2e` browser tests |
| Free disk space | ~500 MB | `node_modules` + workspace |

Automatic check: `npm run doctor`.

## B. macOS endpoint (collector)
Nothing is installed. The script runs with the built-in `/bin/bash` (3.2) and these standard tools (the collector's preflight fails with a clear message if one is missing):

`bash tar gzip awk df find sed tr cut head cp mv stat date od shasum` — plus, per artifact: `ps netstat lsof sw_vers dscl launchctl crontab log`

| Run it as | Sees |
|---|---|
| Ordinary user | Baseline, process list, own-user data, public logs, own crontab (fallback) |
| root (via your EDR) | Adds unified log (`log show`), system crontabs/at jobs, all `/Library/Launch*`, all users' home data |

**macOS privacy controls (TCC).** Even root cannot read some user data (Safari, some app data) unless your organization granted **Full Disk Access** to the process that runs the script (typically the EDR agent). The collector never grants access or edits privacy settings; blocked reads are recorded as `failed` with the reason.

Other requirements: writable output root with enough free space (default reserve 512 MiB), and the unpacked package kept intact (preflight checks `collection-plan.json` against its recorded digest).

Commands (from `RUN-INSTRUCTIONS.txt`):
```bash
/bin/bash "<unpack dir>/collector.sh" --preflight-only
/bin/bash "<unpack dir>/collector.sh" --run
```
Status: collector **implemented, unverified** — executed only on a dev Mac with synthetic fixtures (ordinary privileges). See [support-matrix.md](support-matrix.md).
