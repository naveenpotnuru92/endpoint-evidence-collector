// Builds SYNTHETIC collection results (index + manifest + archive parts) in the same format the collectors write.
// Used for golden fixtures and verifier tests. Contains no real host or personal data.
import { createHash } from "node:crypto";
import * as fsx from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tarGz, zipStore, type PkgFile } from "../../packages/generator/src/archive.ts";

export interface SynthFile { name: string; content: string; outcome?: "collected" | "partial" | "failed" | "skipped"; skipReason?: string; error?: string; profile?: string; artifactId?: string }
export interface SynthOpts {
  runId?: string; files: SynthFile[]; state: "complete" | "partial" | "failed" | "cancelled"; zip?: boolean; perPart?: number;
  /** after building: tamper */ corruptPart?: number; dropPart?: number; badManifestHash?: boolean; failedParts?: string[]; targetOs?: "windows" | "macos" | "linux";
}
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export function buildSynthRun(dir: string, o: SynthOpts) {
  mkdirSync(dir, { recursive: true });
  const runId = o.runId ?? "run-20261007T000000Z-deadbeef";
  const planDigest = sha("synthetic-plan");
  const packaged = o.files.filter((f) => (f.outcome ?? "collected") === "collected" || f.outcome === "partial");
  const perPart = o.perPart ?? 2;
  const parts: { name: string; bytes: number; sha256: string; members: number }[] = [];
  const ext = o.zip ? "zip" : "tar.gz";
  for (let i = 0; i < packaged.length; i += perPart) {
    const chunk = packaged.slice(i, i + perPart);
    const pf: PkgFile[] = chunk.map((f) => ({ name: f.name, data: new TextEncoder().encode(f.content) }));
    const data = o.zip ? zipStore(pf) : tarGz(pf);
    const name = `part-${String(parts.length + 1).padStart(3, "0")}.${ext}`;
    writeFileSync(join(dir, name), data);
    parts.push({ name, bytes: data.length, sha256: sha(data), members: chunk.length });
  }
  const entries = o.files.map((f) => {
    const outcome = f.outcome ?? "collected";
    const has = outcome === "collected" || outcome === "partial";
    return { artifactId: f.artifactId ?? "synthetic.artifact", profile: f.profile ?? null, sourcePath: "/synthetic/source/" + f.name, destination: has ? f.name : null,
      method: "copy" as const, outcome, acquiredUtc: "2026-10-07T00:00:01Z", bytes: has ? Buffer.byteLength(f.content) : 0, sha256: has ? sha(f.content) : null,
      error: f.error ?? null, skipReason: f.skipReason ?? null, consistencyNote: null, timeFilterApplied: false };
  });
  const manifest = { schemaVersion: 1, runId, planId: "plan-0123456789ab", planDigest, catalogVersion: "0.1.0", generatorVersion: "0.1.0", targetOs: o.targetOs ?? "linux",
    host: { name: "synthetic-host", osVersion: "Synthetic OS 1.0", identity: "synthetic-user", elevated: false }, startedUtc: "2026-10-07T00:00:00Z", finishedUtc: "2026-10-07T00:00:05Z", entries };
  const mtext = JSON.stringify(manifest, null, 2);
  writeFileSync(join(dir, "manifest.json"), mtext);
  const index = { schemaVersion: 1, runId, planId: manifest.planId, planDigest, finalizationState: o.state, manifestName: "manifest.json",
    manifestSha256: o.badManifestHash ? "0".repeat(64) : sha(mtext), expectedParts: parts, failedParts: o.failedParts ?? [] };
  writeFileSync(join(dir, "retrieval-index.json"), JSON.stringify(index, null, 2));
  writeFileSync(join(dir, "status.json"), JSON.stringify({ schemaVersion: 1, runId, planId: manifest.planId, state: o.state, currentArtifact: null, startedUtc: manifest.startedUtc, updatedUtc: manifest.finishedUtc,
    collectedBytes: 0, counts: { ok: 0, partial: 0, failed: 0, skipped: 0 }, failureSummary: [] }));
  if (o.corruptPart !== undefined) { const p = join(dir, parts[o.corruptPart]!.name); const b = Buffer.from(fsx.readFileSync(p)); b[b.length - 20] ^= 0xff; writeFileSync(p, b); }
  if (o.dropPart !== undefined) fsx.rmSync(join(dir, parts[o.dropPart]!.name));
  return { dir, parts, runId };
}

/** Map every file in a run dir to the `files` input the verifier expects (an explicit "picker"). */
export function filesIn(dir: string): Record<string, string> {
  const fs = fsx;
  return Object.fromEntries(fs.readdirSync(dir).filter((n) => /^[A-Za-z0-9._-]+$/.test(n) && fs.statSync(join(dir, n)).isFile()).map((n) => [n, join(dir, n)]));
}
