# Endpoint Evidence Collector

A **local-first planner, package generator and result verifier** for authorized troubleshooting,
security investigations and evidence collection.

You run the planner on your Mac. It produces a reviewed script package. **You** move that package to an
endpoint through your internal EDR, run it there, pull the results back through the EDR, and verify them
locally. The app itself never contacts, controls or executes anything on an endpoint.

> **Release-candidate status (read this first).** Everything below is implemented and tested with
> synthetic fixtures. The Unix (macOS/Linux) collector has been *run* on a macOS dev machine against
> synthetic fixture profiles. The **Windows collector has not been executed anywhere** (no Windows/PowerShell
> available while building). No collector has been validated on target OS builds or through your EDR, so every
> collector is labelled **implemented, unverified**. See [docs/release-checklist.md](docs/release-checklist.md)
> for the blockers. Do not run it on production endpoints without separate authorization.

---

## 1. What it does (and does not do)

| Does | Does not |
|---|---|
| Plan which artifacts to collect (Windows / macOS / Linux) from a reviewed catalog | Run commands on endpoints, or connect to your EDR |
| Generate a deterministic package: `collector.sh` / `collector.ps1`, plan, hashes, instructions | Accept arbitrary shell/PowerShell from the UI |
| Verify retrieved results (hashes, archive safety, completeness) and export JSON/HTML reports | Collect credentials, cookies, session tokens, password stores, or bypass any protection |
| Run entirely offline on `127.0.0.1` (no telemetry, no CDN) | Upload anything, encrypt output, or claim forensic completeness |

---

## 2. What you need

| Requirement | Why |
|---|---|
| macOS operator machine | Where the planner runs (the code also runs on Linux for development) |
| **Node.js ≥ 22** (`node -v`) and npm | Runs the local service and builds the UI |
| A browser (Chrome, Safari, Firefox …) | Opens the UI at `http://127.0.0.1:<port>/` |
| *(only for `npm run test:e2e` UI tests)* Google Chrome in `/Applications` | Browser end-to-end tests (skipped automatically if absent) |

**Endpoints need nothing installed**: macOS/Linux use `bash`, `tar`, `gzip`, `awk`, `df`, `find`, `sed`, `shasum`/`sha256sum`
(all standard). Windows uses built-in PowerShell 5.1+. No Python or Node on endpoints.

**Check your Mac automatically:** `npm run doctor`. Per-OS endpoint requirements: [macOS](docs/REQUIREMENTS-macos.md) · [Windows](docs/REQUIREMENTS-windows.md).

### Files you need (and where they live)

| Path | What it is | Needed at |
|---|---|---|
| `package.json`, `package-lock.json` | Dependency lock — reproducible installs | build |
| `packages/schema` | Strict plan/run/index types + validation | build/run |
| `packages/catalog` | Versioned artifact catalog, aliases, presets, search | build/run |
| `packages/generator` | Deterministic package assembly | run |
| `packages/verifier` | Index/archive/hash verification, report export | run |
| `collectors/_shared`, `collectors/macos`, `collectors/linux`, `collectors/windows` | **The reviewed endpoint scripts** (static templates) | run (generator reads them) |
| `apps/local-service` | Loopback-only API + static UI server | run |
| `apps/ui` | React UI | build |
| `tests/`, `scripts/` | Automated verification, smoke test, bundle builder | dev |
| `examples/plans/*.json` | Sample plans (no personal data) | reference |
| `docs/` | Operator guide, threat model, support matrix, etc. | reference |

The **release bundle** (section 5) contains only what is needed to *run* the app.

---

## 3. Quick start (development launcher — one command)

```bash
cd ~/endpoint-evidence-collector
npm install            # first time only (uses the committed lockfile)
npm run app            # builds the UI, starts the service, opens your browser
```

You will see:

```
Endpoint Evidence Collector (planning + verification only; never runs endpoint commands)
  UI:        http://127.0.0.1:54321/
  Workspace: /Users/<you>/.endpoint-evidence-collector
  Stop with Ctrl+C.
```

Useful environment variables: `EEC_PORT` (fixed port), `EEC_WORKSPACE` (where saved plans live), `EEC_NO_OPEN=1` (don't open a browser).

---

## 4. End-to-end walkthrough (step by step)

### Step 1 — Plan (in the UI)

1. **Start → Start a new plan.**
2. **Target:** pick Windows, macOS or Linux, then a preset (*Quick triage*, *Investigation*, *Targeted*).
   If you already have selections, you get a preview of what a preset would add/remove before anything changes.
3. **Artifacts:** search (`registry`, `cron`, `browser`, `startup`, `auth` …) or browse groups. Search only *suggests*;
   nothing is selected until you add it. Click **Details** for exact sources, method, privileges and limits.
   Sensitive options (process command lines) are separate, never included by "Select all".
4. **Scope & limits:** user scope (default: all normal local profiles), time window (with explicit timezone → UTC),
   size/runtime limits, output root **on the endpoint**, optional literal custom file paths.
5. **Review:** every issue has a **Fix** link. Check personal-data and unverified-collector notices.
6. **Export:** download the plan JSON and/or **Generate package**. Note the package SHA-256 (hash only — *not a signature*).
   Optionally **Save plan locally** (explicit; stored under the workspace folder, deletable from Start).

### Step 2 — Transfer & run (on the endpoint, via your internal EDR)

Open `RUN-INSTRUCTIONS.txt` from the package (or the Export screen) — it has the exact commands for your plan.
Typical flow (paths marked *EXAMPLE* are placeholders for where **you** unpack the package):

```bash
# macOS / Linux
mkdir -p "/var/tmp/eec" && tar -xzf "/var/tmp/eec-package.tar.gz" -C "/var/tmp/eec"
/bin/bash "/var/tmp/eec/collector.sh" --preflight-only     # checks only, creates nothing
/bin/bash "/var/tmp/eec/collector.sh" --run                # collect (foreground)
```
```powershell
# Windows (no execution-policy bypass; if policy blocks it, use your organization's approved route)
Expand-Archive -LiteralPath "C:\Staging\eec-package.zip" -DestinationPath "C:\Staging\eec"
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "C:\Staging\eec\collector.ps1" -Run
```

The collector prints `RUN_ID`, `RUN_DIR` and `STATUS`. Exit codes:

| Code | Meaning |
|---|---|
| 0 | complete |
| 10 | partial (some failures / skips / limits) |
| 20 | preflight failure (nothing collected) |
| 30 | interrupted or runtime budget exhausted (finalized with what was collected) |
| 40 | packaging failure |

Check `status.json` in the run directory (`state`: preflight → collecting → packaging → complete/partial/failed/cancelled).
A run is finished only when a `FINALIZED` file exists next to it.

### Step 3 — Retrieve (via the EDR)

Pull from the run directory: `retrieval-index.json`, `manifest.json`, `status.json`, and every `part-*.tar.gz` / `part-*.zip`
(optionally `run.log`). Output is **not encrypted** — treat it as sensitive evidence.

### Step 4 — Verify (in the UI)

**Verify** → *Choose files…* (select the index, manifest, status and all parts) → **Verify**.
You get two separate verdicts:

* **Integrity** — do the bytes match what the collector recorded (index → parts → every file hash)?
* **Completeness** — complete / partial / incomplete (failed, skipped-by-limit, missing parts, interrupted).

Browse the coverage matrix and entries (metadata only — contents are never previewed), then **Export summary JSON** or **Export HTML report**.
A matching hash does **not** prove the endpoint or collector was trustworthy.

### Step 5 — Cleanup (deliberate, separate, after verification)

```bash
/bin/bash "/var/tmp/eec/collector.sh" --cleanup "<run directory>" --yes
```
```powershell
& "...\powershell.exe" -NoProfile -NonInteractive -File "C:\Staging\eec\collector.ps1" -Cleanup "<run directory>" -Yes
```
It only deletes a directory whose name looks like `run-<timestamp>-<id>` **and** that contains the collector's ownership marker;
it refuses symlinks, other paths and anything without `--yes`. This is ordinary deletion, **not secure erasure**.

---

## 5. Release bundle (distributable)

```bash
npm run bundle           # -> release/eec-0.1.0/ and release/eec-0.1.0.tar.gz (+ SHA-256 printed)
npx tsx scripts/check-bundle.mts   # starts the bundled server outside the repo and checks it
```
On the target Mac: `tar -xzf eec-0.1.0.tar.gz && cd eec-0.1.0 && ./start.sh` (needs Node ≥ 22).
The bundle is **not code-signed or notarized**; verify the tarball SHA-256 you were given and `BUNDLE-MANIFEST.txt`.

---

## 6. Testing — how to run everything

| Command | What it runs | Time |
|---|---|---|
| `npm run typecheck` | TypeScript across all packages/apps | seconds |
| `npm run test:unit` | schema, catalog, generator, verifier, service, golden fixtures, examples, UI logic | ~1 s |
| `npm run test:e2e` | **Real collector** end-to-end on synthetic fixtures **+ browser UI tests in Chrome** (keyboard flow, axe a11y, screenshots, network check) | ~30 s |
| `npm test` | Everything above | ~30 s |
| `npm run smoke` | **One-command smoke test** over real HTTP: service → plan → package → collector run → upload → verify → tamper → cleanup | ~10 s |
| `npm run check` | typecheck + all tests + smoke | ~45 s |
| `npm run fixtures` | Regenerate golden synthetic collections in `tests/fixtures/golden/` | instant |

Details of what each test proves are in [docs/testing.md](docs/testing.md). Screenshots from the browser tests are written to `docs/screenshots/`.

---

## 7. Repository map

```
apps/ui/                React UI (Start, Plan workspace, Verify/Report, Settings)
apps/local-service/     Loopback API (token + Host/Origin checks), plan storage, generation, import/verify jobs
packages/schema/        Plan, run-status, manifest, retrieval-index schemas; path safety; plan migrations
packages/catalog/       Artifacts, categories, presets, search, dependency resolution
packages/generator/     Deterministic package assembly (conf builder, instructions, zip/tar writers)
packages/verifier/      Streaming tar.gz/zip verification, limits, HTML/JSON reports
collectors/             Reviewed endpoint scripts (Unix core + OS artifact files; Windows PowerShell)
tests/ scripts/         Tests, fixtures, smoke test, bundle builder
docs/                   Operator guide, support matrix, threat model, acquisition notes, developer guide, release checklist
examples/plans/         Sample plans
```

## 8. Documentation index

* [docs/REQUIREMENTS-macos.md](docs/REQUIREMENTS-macos.md) / [docs/REQUIREMENTS-windows.md](docs/REQUIREMENTS-windows.md) — what each OS needs
* [docs/operator-guide.md](docs/operator-guide.md) — day-to-day use, footprint, interrupted runs, troubleshooting
* [docs/support-matrix.md](docs/support-matrix.md) — per-OS / per-category coverage and verification state
* [docs/threat-model.md](docs/threat-model.md) — assumptions, mitigations, residual risks
* [docs/acquisition-notes.md](docs/acquisition-notes.md) — sources, commands, caveats, references to validate
* [docs/developer-guide.md](docs/developer-guide.md) — architecture, adding an artifact, formats
* [docs/testing.md](docs/testing.md) — test inventory and what each proves
* [docs/release-checklist.md](docs/release-checklist.md) — release blockers and outstanding validation

## 9. License

`LICENSE` currently contains an **ISC placeholder**. The license decision belongs to the project owner/organization
(see release checklist). Third-party notices: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
