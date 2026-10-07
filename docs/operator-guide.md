# Operator guide

Audience: the person who plans collections on a Mac, hands packages to the EDR team (or does it themselves), and verifies results.
For the 5-step walkthrough see the [README](../README.md#4-end-to-end-walkthrough-step-by-step). This guide covers the details.

## Mac setup
1. Install Node.js ≥ 22 (`node -v`).
2. Development launcher: `npm install && npm run app`. Release bundle: unpack and run `./start.sh`.
3. The service listens on `127.0.0.1` only; the browser tab receives an ephemeral session token. Closing the terminal stops the service.
4. Saved plans: `~/.endpoint-evidence-collector/plans/*.json` (override with `EEC_WORKSPACE`). They are plain JSON you can inspect or delete (Start screen → Delete).
   Import jobs (uploads for verification) live in `<workspace>/jobs/` and are purged on every service start or when you press **Discard imported copies**.
5. Settings (theme, default limits, EDR transport profile) are kept in memory until **Save settings** writes one key to browser local storage; **Delete stored settings** removes it.

## Choosing scope
* **All normal profiles** (default): every ordinary local account found on the endpoint, inactive ones included where readable. System/service accounts are excluded unless you tick *Include system / service profiles*.
* **Named accounts**: exact account names (one per line). Names not found are recorded as `named-account-not-found` and make the run **partial** — never silently dropped.
* **Interactive user**: works only if exactly one interactive user is detected. If zero or several are found, per-user artifacts are skipped, the status says so, and the run is **partial**. The collector never guesses and never uses a service account.
* Selecting a scope never authorizes copying whole profile directories: only the catalog artifacts you selected (plus explicit custom paths) are read.

## Time windows
Entered times are converted to UTC using the timezone you choose (the UI shows the UTC value). Inverted ranges are rejected.
Only artifacts marked **native** filter by time (Windows event logs, macOS unified log, Linux journal). Everything else is copied whole and may contain older records. This is stated in the review, the package and the verification report.

## Limits
Per-file, total, archive part size, max parts, free-space reserve, runtime. Defaults: 250 MiB / 2 GiB / 250 MiB / 64 / 512 MiB / 15 min.
These are planning defaults — **sizes and runtimes are unknown until measured on an endpoint**. Oversize files are skipped with `limit:per-file-bytes (…)`, never truncated.
Commands whose output exceeds the limit are kept but labelled **partial**. When the runtime budget is nearly used up the collector stops collecting, packages what it has and exits 30.

## What the collector does on the endpoint
1. Preflight: OS match, execution identity/elevation (detected, never assumed), plan digest check, tool availability, writable restricted output root, free space. Failure → exit 20, nothing collected.
2. Creates a *new* `run-<UTC timestamp>-<8 hex>` directory (mode 0700 / restrictive ACL) — never reuses or overwrites.
3. Collects volatile data first, then durable sources; every file is hashed (SHA-256) as it is acquired.
4. Packages independently readable parts (`part-001.tar.gz` / `.zip`), writes `manifest.json`, `retrieval-index.json` (which carries the manifest hash and every part hash), updates `status.json` atomically, and writes `FINALIZED` last.
5. Deletes its plaintext `.staging` copy once the parts exist (ordinary deletion, not secure erasure).

## Footprint (what the endpoint will show)
Process execution of `bash`/`powershell`, reads of the selected sources, writes only inside the run directory (+ `latest-<planId>.json` receipt in the output root), EDR/OS audit records of the above, and (macOS/Linux) `ps`, `netstat/ss`, `lsof`, `log`/`journalctl`, `launchctl`/`systemctl` invocations for the artifacts you selected. It makes **no network connections**, installs nothing, changes no settings, and never kills browsers/applications.

## Interrupted or failed runs
* Ctrl+C / SIGTERM: the collector finalizes what it has (state `cancelled`, exit 30). The verifier reports **integrity verified, completeness incomplete**.
* EDR hard-kill: finalization can be lost. Signs: no `FINALIZED`, `status.json` stuck in `collecting`/`packaging`, no `retrieval-index.json`. Pull whatever exists; the run is incomplete. Re-run with smaller scope/limits (smaller runs are the intended answer to tight timeouts).
* Packaging failure (exit 40): `.staging` is kept so you can retrieve plaintext if you must; the index lists `failedParts`.

## Reading verification results
| Integrity | Completeness | Meaning |
|---|---|---|
| verified | complete | Bytes match the index/manifest; everything requested was collected. (Still not proof of endpoint trustworthiness.) |
| verified | partial | Bytes are fine; some artifacts failed, were limited, or scope was unresolved. See coverage/entries. |
| verified | incomplete | Interrupted/cancelled/failed run. |
| failed | any | A part is missing/altered, a file hash differs, the manifest was altered, or the archive is unsafe/malformed. **Do not rely on it.** |
| unsupported | unknown | Unknown schema version (produced by a different tool version). |

## EDR hand-off (unresolved variables)
Record these in **Settings → EDR transport profile** and validate them with a harmless test package first: execution identity, interpreter path, maximum command duration, process-tree lifetime (needed for background mode), transfer size limit, working directory, signing requirements, output permissions. Unknown stays unknown. Do not use background mode, and do not install scheduled tasks/services as a workaround, until you have validated process-lifetime behaviour.

## Troubleshooting
| Symptom | Likely cause / action |
|---|---|
| UI says *Missing or invalid session token* | Reload the tab served by the running service (don't open an old tab after restarting). |
| *Package cannot be generated* | The issue list names the field/artifact (e.g. planned-only collector, missing dependency, stale catalog version). |
| `PREFLIGHT FAILED: digest does not match` | Package files were altered/re-zipped; re-transfer the original. |
| `Blocked by macOS privacy controls (TCC)` | The executing process lacks the org-granted access; the collector will not change privacy settings. |
| Windows: script blocked by policy | Report to the owner of your signing/execution policy; do not bypass. |
| Verification: `missing-part` | Pull every `part-*` listed in the index. |
