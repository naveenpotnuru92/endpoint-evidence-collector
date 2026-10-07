# Release checklist & outstanding validation

**Current label: RELEASE CANDIDATE 0.1.0 — NOT production-ready.** Items marked ☐ are open **release blockers** unless noted. Nothing below marked ☑ was skipped or assumed.

## Done and verified (synthetic fixtures / dev machine)
- ☑ Plan schema, catalog, generator, verifier, local service, UI (unit + e2e + a11y tests, `npm run check`).
- ☑ Unix collector executed on macOS (ordinary privileges) against synthetic fixture profiles; preflight, limits, interruption, cleanup, tamper paths exercised.
- ☑ Offline operation (no external requests in browser test), loopback-only service with token/Host/Origin enforcement.
- ☑ Release bundle builds and runs standalone (`scripts/check-bundle.mts`).

## Blockers — target-environment validation (cannot be done from the dev machine)
- ☐ **Windows collector**: never executed. Run on disposable Windows 10/11 and Server endpoints, ordinary **and** elevated: all selected artifact types, locked event logs/browser DBs, multiple profiles, missing utilities, interrupted runs (Ctrl+C), large inputs, ACL restriction of run dir, zip part integrity (`part-*.zip` through the verifier).
- ☐ **macOS collector**: elevated run (`log show`, cron, `/Library/*`), real multi-user discovery via `dscl`, TCC behaviour with and without org-granted Full Disk Access (Safari), locked Chrome/Firefox DBs, several macOS versions.
- ☐ **Linux collector**: never executed on Linux. Test on each documented distro (e.g. Ubuntu 22.04/24.04, Debian 12, RHEL 9), systemd and non-systemd, root vs ordinary, `getent`/`who` discovery.
- ☐ **Primary-source verification** of every command/path in [acquisition-notes.md](acquisition-notes.md) against current OS/browser documentation (catalog `references` lists starting points).
- ☐ **Internal EDR acceptance**: execution identity, interpreter, max command duration, process-tree lifetime (gate for background mode), transfer size limit, working directory, signing requirement, output permissions, retrieval of `part-*` files. Update Settings profile + this document with results.
- ☐ Promote catalog statuses to `verified` **only** after the above (update `tests/catalog.test.ts` deliberately).

## Blockers — decisions / dependencies owned by others
- ☐ **Script signing**: only hashes are provided. If your EDR/OS policy requires signed scripts, integrate your organization's signing process (do not use execution-policy bypass).
- ☐ **Encryption of output**: not implemented (needs an approved format and key management). Until then require protected retrieval/storage appropriate to the data.
- ☐ **App signing/notarization** of the bundle: not done; bundle is unsigned.
- ☐ **License decision**: `LICENSE` is an ISC placeholder — project owner/org must choose.
- ☐ Authorization for any run on real endpoints (separate deployment approval).

## Known limitations (not blockers, but disclosed)
- Background execution: instructions generated and labelled *not validated*; no scheduler/service fallback by design.
- Windows broad registry hive export: **planned only** (generation refuses it).
- Linux browser extension/preference collection and Safari config are not implemented; Snap/Flatpak browser paths not covered.
- Time filtering is native only for event logs / unified log / journal; file copies are whole.
- Verifier does not support ZIP64 or encrypted zips (reported as unsupported/unreadable, never silently passed).
- TOCTOU and live-file consistency limits (see threat model).
- Verification jobs rely on explicit upload via the UI; very large collections are bounded by `maxImportBytes` (8 GiB default).

## Pre-release steps
1. `npm ci && npm run check` — all green.
2. `npm run bundle && npx tsx scripts/check-bundle.mts`; record the tarball SHA-256.
3. Complete the validation list above and update `docs/support-matrix.md`.
4. Re-read `THIRD-PARTY-NOTICES.md` after dependency changes (`npm ls --omit=dev`).
5. Tag only when blockers are closed or explicitly accepted in writing.
