# Threat model & assumptions

## Assets
Collected evidence (may include personal data), the plan (reveals investigation scope), the operator's Mac session, endpoint integrity.

## Trust boundaries
1. **Browser ↔ local service** (loopback). 2. **Package ↔ endpoint** (moved by the EDR). 3. **Retrieved files → verifier** (untrusted input). 4. **Collector ↔ endpoint data** (read-only access to sources; hostile file names/content possible).

## Threats and mitigations
| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Malicious web page calls the local service (CSRF/DNS rebinding) | Bind `127.0.0.1`; Host allowlist; Origin check; no CORS headers; per-session token (constant-time compare) on every `/api` route; token only injected into the UI for valid hosts | `tests/service.test.ts` |
| T2 | Service abused as a shell / file reader | No exec route; plan/job IDs strict-regex; uploads stream into a private job dir with byte caps; static serving blocks traversal; errors never leak stacks/paths | service tests |
| T3 | Plan values become code (injection) | Plan is data. Unix: flat TAB config parsed with `read -r`, never sourced/eval'd; Windows: `ConvertFrom-Json`. Control chars rejected at generation. Collector static-safety tests forbid `eval`, `Invoke-Expression`, networking, persistence, elevation, protection tampering | generator tests |
| T4 | Hostile file/profile names on the endpoint | Destination names sanitized to `[A-Za-z0-9._-]`; originals only in manifest strings (JSON-escaped); NUL-delimited iteration; no interpolation into commands | `e2e` hostile profile `bob $(touch pwned) 'smith'` |
| T5 | Symlink / junction escape; collecting own output | Symlinks/reparse points not followed; sources inside run dir skipped; output root symlink refused; custom paths overlapping output rejected by schema | e2e, schema |
| T6 | Overwrite / clobber | New run dir per run (`mkdir` without `-p`); duplicate destinations get suffixes | e2e |
| T7 | Over-collection / disk exhaustion | Per-file, total, free-space reserve, runtime budget; deterministic skip reasons; never silent truncation | e2e limits |
| T8 | Hostile archives in verifier (zip-slip, symlinks, bombs, duplicates) | Names validated; links/devices rejected; depth/count/expanded/ratio/time/import limits; streaming hash, **no extraction** | `tests/verifier.test.ts` |
| T9 | Report XSS | Everything escaped; CSP `default-src 'none'`; no scripts/links from paths | verifier test |
| T10 | Tampering in transit / storage | Plan digest check at preflight; package hashes; retrieval index with part hashes + manifest hash; per-file hashes | golden + e2e tamper tests |
| T11 | Credential/session theft via the tool | Not implemented by design; catalog test forbids cookie/login/key store names; browser helpers reference only history and preference/extension files | catalog + generator tests |
| T12 | Silent privilege use | Detects identity only; no sudo/runas; fixed `PATH` on Unix | static tests |

## Residual risks (documented, not solved)
* **TOCTOU**: a file can be swapped for a symlink between the check and the copy; reparse-point/symlink checks are best-effort on live systems.
* **Live-file consistency**: databases/logs may change during copy; flagged in `consistencyNote`, not eliminated. Locked-file handling on Unix relies on ordinary read access; Windows uses shared-read streams.
* **No encryption**: output and manifest (which lists paths) are plaintext at rest and in transit. Needs an approved format and key-management decision before use with sensitive data.
* **No signing**: only hashing. Signing must come from your organization's process.
* **Hash ≠ trust**: a compromised endpoint can produce internally consistent but false output.
* **Invalid UTF-8 file names**: Unix JSON output relies on `iconv -c` to drop invalid bytes; names may be altered in the manifest.
* **Local machine trust**: anything running as you on the Mac can read the workspace and the loopback port (token required, but same-user processes can fetch the UI).
* **Deletion is not secure erasure.**
