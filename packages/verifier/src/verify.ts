// Verification of a retrieved collection. All inputs are UNTRUSTED. Nothing is extracted or executed.
import { statSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { RetrievalIndexSchema, ManifestSchema, StatusSchema, type RetrievalIndex, type Manifest, type ManifestEntry } from "@eec/schema";
import { DEFAULT_VERIFY_LIMITS, type VerifyLimits } from "./limits.js";
import { readTarGz, readZip, printable, type Shared, type Problem } from "./members.js";

export type Severity = "error" | "warning" | "info";
export interface Finding { severity: Severity; code: string; message: string }
export type IntegrityResult = "verified" | "failed" | "unsupported";
export type CompletenessResult = "complete" | "partial" | "incomplete" | "unknown";

export interface VerifyInput {
  /** Explicitly imported files, keyed by their bare file name (as listed in the index). */
  files: Record<string, string>;
  /** Optional: the plan JSON the operator exported, to cross-check planDigest. */
  planFileSha256?: string;
  limits?: Partial<VerifyLimits>;
}

export interface EntryRow { artifactId: string; profile: string; source: string; destination: string; method: string; outcome: string; bytes: number; hashStatus: "match" | "mismatch" | "missing-member" | "not-applicable"; error: string; skipReason: string; note: string; timeFilterApplied: boolean }
export interface CoverageRow { artifactId: string; collected: number; partial: number; failed: number; skipped: number; profiles: string[] }

export interface VerifyReport {
  integrity: IntegrityResult;
  completeness: CompletenessResult;
  findings: Finding[];
  run: { runId: string; planId: string; finalizationState: string; host: string; identity: string; elevated: boolean; startedUtc: string; finishedUtc: string | null; catalogVersion: string; generatorVersion: string; targetOs: string } | null;
  parts: { name: string; bytes: number; expectedBytes: number; hashStatus: "match" | "mismatch" | "missing"; members: number }[];
  coverage: CoverageRow[];
  entries: EntryRow[];
  totals: { entries: number; hashMatch: number; hashMismatch: number; missingMember: number; unlistedMembers: number };
  disclaimer: string;
}
export const DISCLAIMER = "A matching hash shows the retrieved bytes equal what the collector recorded. It does not prove the endpoint or collector was trustworthy, or that the source data was complete or authentic.";

/** Skips that mean requested scope was NOT collected (as opposed to "source simply not present"). */
const SCOPE_SKIP = /^(limit:|interactive-users:|named-account-not-found)/;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const SHA = /^[0-9a-f]{64}$/;

function sha256File(p: string): Promise<string> {
  return new Promise((res, rej) => { const h = createHash("sha256"); createReadStream(p).on("data", (c) => h.update(c)).on("end", () => res(h.digest("hex"))).on("error", rej); });
}
function readJson(p: string, max: number): unknown {
  const st = statSync(p); if (st.size > max) throw new Error("file exceeds JSON size limit");
  return JSON.parse(readFileSync(p, "utf8"));
}

export async function verifyCollection(input: VerifyInput): Promise<VerifyReport> {
  const lim: VerifyLimits = { ...DEFAULT_VERIFY_LIMITS, ...input.limits };
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, message: string) => findings.push({ severity, code, message });
  const report: VerifyReport = { integrity: "failed", completeness: "unknown", findings, run: null, parts: [], coverage: [], entries: [], totals: { entries: 0, hashMatch: 0, hashMismatch: 0, missingMember: 0, unlistedMembers: 0 }, disclaimer: DISCLAIMER };
  const startMs = Date.now();

  // total imported size bound (fail before reading anything large)
  let importBytes = 0;
  for (const [n, p] of Object.entries(input.files)) {
    if (!NAME.test(n)) { add("error", "unsafe-file-name", `Imported file name '${printable(n)}' is not allowed.`); return report; }
    try { importBytes += statSync(p).size; } catch { add("error", "unreadable-file", `Imported file '${printable(n)}' cannot be read.`); return report; }
  }
  if (importBytes > lim.maxImportBytes) { add("error", "import-size-limit", "Imported files exceed the size limit."); return report; }

  // --- index ---
  const idxPath = input.files["retrieval-index.json"];
  if (!idxPath) { add("error", "missing-index", "retrieval-index.json was not provided."); return report; }
  let index: RetrievalIndex;
  try {
    const raw = readJson(idxPath, lim.maxJsonBytes) as { schemaVersion?: unknown };
    if (raw && typeof raw === "object" && raw.schemaVersion !== 1) { add("error", "unknown-schema", `Unsupported index schemaVersion '${String(raw.schemaVersion)}'.`); report.integrity = "unsupported"; return report; }
    const r = RetrievalIndexSchema.safeParse(raw);
    if (!r.success) { add("error", "malformed-index", "retrieval-index.json does not match the expected structure."); return report; }
    index = r.data;
  } catch (e) { add("error", "malformed-index", `retrieval-index.json is not valid JSON (${(e as Error).message}).`); return report; }
  if (new Set(index.expectedParts.map((p) => p.name)).size !== index.expectedParts.length) add("error", "duplicate-part", "Index lists duplicate part names.");
  if (index.planDigest && input.planFileSha256 && index.planDigest !== input.planFileSha256) add("error", "plan-digest-mismatch", "Index plan digest differs from the supplied plan file.");

  // --- manifest ---
  let manifest: Manifest | null = null;
  const mPath = input.files[index.manifestName];
  let integrityOk = true;
  if (!mPath) { add("error", "missing-manifest", "Manifest file was not provided."); integrityOk = false; }
  else {
    const mh = await sha256File(mPath);
    if (mh !== index.manifestSha256) { add("error", "manifest-hash-mismatch", "Manifest SHA-256 does not match the index."); integrityOk = false; }
    try {
      const raw = readJson(mPath, lim.maxJsonBytes) as { schemaVersion?: unknown };
      if (raw && typeof raw === "object" && raw.schemaVersion !== 1) { add("error", "unknown-schema", `Unsupported manifest schemaVersion '${String(raw.schemaVersion)}'.`); report.integrity = "unsupported"; return report; }
      const r = ManifestSchema.safeParse(raw);
      if (!r.success) { add("error", "malformed-manifest", "Manifest does not match the expected structure."); integrityOk = false; }
      else manifest = r.data;
    } catch { add("error", "malformed-manifest", "Manifest is not valid JSON."); integrityOk = false; }
  }
  if (manifest) {
    if (manifest.runId !== index.runId) { add("error", "run-id-mismatch", "Manifest and index run IDs differ."); integrityOk = false; }
    if (manifest.planId !== index.planId || manifest.planDigest !== index.planDigest) { add("error", "plan-identity-mismatch", "Manifest and index plan identity differ."); integrityOk = false; }
    report.run = { runId: manifest.runId, planId: manifest.planId, finalizationState: index.finalizationState, host: printable(manifest.host.name), identity: printable(manifest.host.identity), elevated: manifest.host.elevated, startedUtc: manifest.startedUtc, finishedUtc: manifest.finishedUtc, catalogVersion: manifest.catalogVersion, generatorVersion: manifest.generatorVersion, targetOs: manifest.targetOs };
  }
  // optional status.json
  let statusState: string | null = null;
  if (input.files["status.json"]) {
    try { const s = StatusSchema.safeParse(readJson(input.files["status.json"], lim.maxJsonBytes)); if (s.success) { statusState = s.data.state; if (s.data.runId !== index.runId) { add("error", "status-run-mismatch", "status.json belongs to a different run."); integrityOk = false; } } else add("warning", "malformed-status", "status.json could not be parsed."); } catch { add("warning", "malformed-status", "status.json is not valid JSON."); }
  }

  // --- parts ---
  const shared: Shared = { expanded: 0, members: 0 };
  const memberHashes = new Map<string, { sha256: string; bytes: number }>();
  let missingParts = 0;
  for (const part of index.expectedParts) {
    if (Date.now() - startMs > lim.maxSeconds * 1000) { add("error", "time-limit", "Verification time limit reached."); integrityOk = false; break; }
    const pp = input.files[part.name];
    if (!pp) { missingParts++; report.parts.push({ name: part.name, bytes: 0, expectedBytes: part.bytes, hashStatus: "missing", members: 0 }); add("error", "missing-part", `Archive part ${printable(part.name)} was not provided.`); integrityOk = false; continue; }
    const size = statSync(pp).size, h = await sha256File(pp);
    const ok = h === part.sha256 && size === part.bytes;
    report.parts.push({ name: part.name, bytes: size, expectedBytes: part.bytes, hashStatus: ok ? "match" : "mismatch", members: part.members });
    if (!ok) { add("error", "part-hash-mismatch", `Archive part ${printable(part.name)} does not match the index (size or SHA-256).`); integrityOk = false; continue; }
    const res = part.name.endsWith(".zip") ? await readZip(pp, size, lim, shared) : part.name.endsWith(".tar.gz") ? await readTarGz(pp, size, lim, shared) : null;
    if (!res) { add("error", "unsupported-part-type", `Part ${printable(part.name)} has an unsupported archive type.`); integrityOk = false; continue; }
    res.problems.forEach((pr: Problem) => { add("error", pr.code, `${printable(part.name)}: ${pr.message}`); integrityOk = false; });
    if (res.members.length !== part.members && res.problems.length === 0) add("warning", "member-count-differs", `Part ${printable(part.name)} has ${res.members.length} members; index says ${part.members}.`);
    for (const m of res.members) {
      if (memberHashes.has(m.name)) { add("error", "duplicate-member", `Member '${printable(m.name)}' appears in more than one part.`); integrityOk = false; }
      memberHashes.set(m.name, { sha256: m.sha256, bytes: m.bytes });
    }
  }
  index.failedParts.forEach((f) => add("warning", "collector-reported-failed-part", `Collector reported: ${printable(f)}`));

  // --- cross-check manifest entries vs members ---
  const cov = new Map<string, CoverageRow>();
  const claimed = new Set<string>();
  if (manifest) {
    for (const e of manifest.entries as ManifestEntry[]) {
      let hashStatus: EntryRow["hashStatus"] = "not-applicable";
      if (e.destination && e.sha256 && (e.outcome === "collected" || e.outcome === "partial")) {
        const bad = e.destination.includes("..") || e.destination.startsWith("/") ;
        const m = bad ? undefined : memberHashes.get(e.destination);
        claimed.add(e.destination);
        if (!m) { hashStatus = "missing-member"; report.totals.missingMember++; }
        else if (m.sha256 === e.sha256 && m.bytes === e.bytes) { hashStatus = "match"; report.totals.hashMatch++; }
        else { hashStatus = "mismatch"; report.totals.hashMismatch++; integrityOk = false; }
      }
      report.entries.push({ artifactId: printable(e.artifactId), profile: printable(e.profile ?? ""), source: printable(e.sourcePath ?? ""), destination: printable(e.destination ?? ""), method: e.method, outcome: e.outcome, bytes: e.bytes, hashStatus, error: printable(e.error ?? ""), skipReason: printable(e.skipReason ?? ""), note: printable(e.consistencyNote ?? ""), timeFilterApplied: e.timeFilterApplied });
      const c = cov.get(e.artifactId) ?? { artifactId: printable(e.artifactId), collected: 0, partial: 0, failed: 0, skipped: 0, profiles: [] };
      c[e.outcome]++; if (e.profile && !c.profiles.includes(printable(e.profile)) && c.profiles.length < 50) c.profiles.push(printable(e.profile)); cov.set(e.artifactId, c);
    }
    report.totals.entries = manifest.entries.length;
    for (const k of memberHashes.keys()) if (!claimed.has(k)) { report.totals.unlistedMembers++; add("warning", "unlisted-member", `Archive member '${printable(k)}' is not listed in the manifest.`); }
    if (report.totals.missingMember > 0) add("error", "missing-members", `${report.totals.missingMember} manifest file(s) were not found in the retrieved parts.`);
    if (report.totals.hashMismatch > 0) add("error", "file-hash-mismatch", `${report.totals.hashMismatch} acquired file(s) do not match their recorded SHA-256.`);
  }
  report.coverage = [...cov.values()].sort((a, b) => a.artifactId.localeCompare(b.artifactId));

  report.integrity = integrityOk && report.totals.missingMember === 0 ? "verified" : "failed";

  // --- completeness (separate from integrity) ---
  const finalized = existsFinalized(input);
  if (!manifest) report.completeness = "unknown";
  else if (missingParts > 0 || index.failedParts.some((f) => !f.startsWith("limit:")) || index.finalizationState === "failed" || index.finalizationState === "cancelled") report.completeness = "incomplete";
  else if (statusState && !["complete", "partial"].includes(statusState)) report.completeness = "incomplete";
  else if (index.finalizationState === "partial" || index.failedParts.length > 0 || manifest.entries.some((e) => e.outcome === "failed" || e.outcome === "partial" || (e.outcome === "skipped" && SCOPE_SKIP.test(e.skipReason ?? "")))) report.completeness = "partial";
  else report.completeness = "complete";
  if (finalized === false) add("warning", "no-finalized-marker", "FINALIZED marker was not provided/imported; confirm the run finished on the endpoint.");
  if (manifest && manifest.entries.some((e) => e.timeFilterApplied === false && e.outcome === "collected" && e.method === "copy")) add("info", "time-filter-not-applied", "Some files were copied whole; time-window filtering applies only to artifacts marked native. Older records may be present.");
  if (manifest && manifest.entries.some((e) => e.consistencyNote)) add("info", "consistency-notes", "Some artifacts were live copies/exports and may be internally inconsistent; see per-entry notes.");
  const fb = report.entries.filter((e) => e.note.startsWith("FALLBACK")).length;
  if (fb > 0) add("info", "fallback-used", `${fb} item(s) were collected through a fallback source and contain partial information only; see the entry notes.`);
  return report;
}

function existsFinalized(input: VerifyInput): boolean | undefined {
  const p = input.files["FINALIZED"]; if (p === undefined) return undefined; return existsSync(p);
}
void SHA;
