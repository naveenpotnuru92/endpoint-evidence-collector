# Testing — inventory and what each test proves

Run everything: `npm run check` (typecheck + all tests + smoke). Individual groups are in README §6.

| File | Count | Proves |
|---|---|---|
| `tests/schema.test.ts` | 33 | Strict schema (unknown fields rejected), inverted/half-open ranges, scope exclusivity, limits, ID injection, path traversal/globs/UNC/ADS/reserved names/tilde/`$()`/newlines, Unicode+spaces accepted, unsafe output roots and evidence-tree roots, custom-path/output overlap |
| `tests/catalog.test.ts` | 14 | Unique IDs, per-OS prefixes, no credential stores listed, presets exclude sensitive options and use same-OS IDs, quick-triage has no browser data, registry/launchd OS-only, honest status (nothing verified), alias search per OS, **no-match never expands scope**, dependency auto-add reporting, select-all excludes sensitive |
| `tests/generator.test.ts` | 36 | Determinism, package-manifest hashes, files per OS, collector bytes independent of plan, hostile text stays data, control chars refused, invalid/planned/sensitive/dependency/wrong-OS/stale-catalog refusals, support disclosure, no execution-policy bypass, quoted paths, background labelled unvalidated, **static safety scan** of all three collectors (no eval/iex/network/persistence/elevation/tampering; no credential store names) |
| `tests/verifier.test.ts` | 29 | Golden scenarios (complete tar/zip, partial, corrupted, missing part, interrupted), manifest tamper, per-file hash mismatch, unknown schema → unsupported, malformed/missing index, unsafe names, plan digest, import limit, **hostile archives** (traversal, absolute, drive, backslash, symlink, hardlink, device, `a//b`, control chars, duplicates, nesting, member/expanded limits, truncation), no extraction to disk, escaped HTML report, real deflate zip |
| `tests/golden.test.ts` | 7 | Committed synthetic golden collections classify correctly; non-success never presented as success |
| `tests/service.test.ts` + `service-purge.test.ts` | 20 | Loopback bind, token required, foreign Host/Origin denied, no CORS, CSP, traversal blocked, body cap, no exec/file routes, no stack/path leaks, plan CRUD/migration, generation, import→verify→report→delete, unsafe/oversize uploads, tamper visible, job purge at startup |
| `apps/ui/src/lib/lib.test.ts` | 13 | Timezone→UTC (DST, half-hour zones), draft→plan mapping, hostile text literal, sensitive selection implication, preset diff preview |
| `tests/examples.test.ts` | 3 | Sample plans validate and generate |
| **`tests/e2e.test.ts`** | 19 | **Plan → generator → real `collector.sh` → retrieval files → verifier.** Complete run (all users + nested profiles, hostile profile name not executed, credential files never collected, only selected artifacts), restrictive permissions, no overwrite, named/interactive scope behaviour, per-file limit skip, multi-part archives, custom paths (Unicode/spaces, symlink, missing), command lines gated, baseline/volatile, preflight-only, **4 preflight failure paths (exit 20)**, **SIGTERM interruption (exit 30, finalized, incomplete)**, cleanup guards, unreadable source → failed, tamper detected |
| **`tests/ui.e2e.test.ts`** | 7 | **Real Chrome against the real service + built UI:** keyboard-only plan completion, honest no-match, suggestions unselected, sensitive subgroup excluded from select-all, drawer + Escape, field-level validation + Fix focus, JSON export contents, package generation + digest, **stale-export invalidation**, OS switch clears stale artifacts, preset preview dialog, verify upload + separate integrity/completeness, HTML report export, settings unknowns, overflow at 1024/390 px, dark theme, **axe WCAG A/AA on 7 screens**, **zero external network requests**, zero console errors; screenshots → `docs/screenshots/` |
| `scripts/smoke.mts` | 10 steps | One-command real-HTTP path: auth, CSP, catalog, plan save, deterministic package, preflight, real collector run, upload+verify (hash count), tamper detection, guarded cleanup |
| `scripts/check-bundle.mts` | 3 | Bundled server runs outside the repo, finds collector templates, enforces token |

## Bugs the end-to-end tests found (fixed)
1. Interactive/named scope that matched nothing reported **complete** → now **partial** (collector + verifier).
2. Upload handler race (resolved before the file flushed) → `stream/promises.pipeline`.
3. Mobile layout: step rail forced horizontal page scroll → grid children `min-width: 0`.
4. Axe: scrollable summary panel not keyboard-focusable → `tabIndex=0`.
5. Validation hid cross-field errors when any number was blank → defaults substituted so all problems show at once.
6. "Fix" links for form-level issues focused the wrong field.

## What is NOT covered (see release checklist)
Windows collector execution; Linux collector execution; elevated runs; real browsers with locked databases; macOS TCC/Full Disk Access behaviour; very large inputs and real timeouts; EDR transfer limits/process lifetime; real multi-user hosts; signing/encryption.
