# Developer guide

## Architecture
```
UI (React) ──HTTP+token──► local-service ──► schema / catalog / generator / verifier
                                              │
                         collectors/* (static templates) ◄── read by generator, shipped in package
```
* **Plan** (`packages/schema/src/plan.ts`): strict zod schema + cross-field `superRefine` (time ranges, scope exclusivity, limits, paths). Anything not listed is rejected.
* **Catalog** (`packages/catalog/src/artifacts.ts`): one `ArtifactDef` per artifact with sources, method, privilege, sensitivity, time-filter semantics, failure modes, output naming, per-OS implementation status. Search and dependency resolution live in `index.ts`.
* **Generator** (`packages/generator`): validates → `checkGeneratable` (planned-only, dependencies, sensitive gates, catalog version) → writes `collection-plan.json`, `collector.conf` (Unix), `REVIEW-SUMMARY.txt`, `RUN-INSTRUCTIONS.txt`, `package-manifest.json` → deterministic zip (Windows) / tar.gz (Unix). Same plan ⇒ same bytes.
* **Collectors**: Unix script = `unix-core.sh` + `unix-browsers.sh` + `<os>/artifacts.sh` + `unix-main.sh` concatenated verbatim (bash 3.2 compatible). Windows = `collectors/windows/collector.ps1`.
* **Verifier**: streaming readers (`members.ts`) hash members without extracting; `verify.ts` cross-checks index ↔ manifest ↔ parts ↔ files and separates integrity from completeness; `report.ts` renders escaped HTML/JSON.
* **Service** (`apps/local-service/src/server.ts`): see [threat-model](threat-model.md).

## Formats
* `retrieval-index.json`, `manifest.json`, `status.json`: `packages/schema/src/run.ts` (schemaVersion 1). Unknown versions → verifier reports *unsupported*.
* Saved plans: `{ savedFormat:1, savedAtUtc, plan }`; `migratePlan()` upgrades by schemaVersion and rejects newer ones.

## Adding an artifact
1. Add an `ArtifactDef` in `artifacts.ts` (ID prefix `win.`/`mac.`/`lin.`). Mark status `implemented-unverified` only if a collector function exists; otherwise `planned`.
2. Unix: add `art_<id with dots→underscores>()` in `collectors/<os>/artifacts.sh` using `copy_file`, `copy_tree`, `cmd_to_file`, `for_each_profile`. Windows: add `$Artifacts['<id>'] = { … }`. Dispatch is by static function/table lookup — no dynamic code.
3. If it is sensitive, give it `sensitivity: "sensitive-option"`, `selectAllExcluded: true`, a dependency if needed, and a gate in `generate.ts` + collector (`require_sensitive`).
4. Add fixtures/tests (`tests/e2e.test.ts` pattern), update `docs/support-matrix.md` and `acquisition-notes.md`. `tests/catalog.test.ts` enforces the invariants (unique IDs, per-OS prefixes, no credential stores, presets exclude sensitive options, no premature `verified`).

## Marking something *verified*
Only after testing on the target OS build **and** through the EDR, with notes in the release checklist. `tests/catalog.test.ts` currently asserts nothing is verified; change that test deliberately when it's true.

## Conventions
TypeScript strict; no runtime network calls; comments explain *why* (security reasoning), not what. Keep UI, plan data, command generation and acquisition logic separate. Never build a command from plan data.

## Commands
`npm run typecheck | test | test:unit | test:e2e | smoke | check | fixtures | bundle | app` — see README §6.
