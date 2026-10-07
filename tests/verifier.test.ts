import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { verifyCollection, renderHtmlReport, summaryJson } from "@eec/verifier";
import { buildSynthRun, filesIn } from "./helpers/synth-run.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "eec-verify-"));
const F = [
  { name: "baseline/system.txt", content: "synthetic baseline" },
  { name: "volatile/processes.txt", content: "synthetic procs" },
  { name: "browser/alice/Chrome/Default/History", content: "SYNTHETIC-HIST", profile: "alice/Chrome/Default" },
  { name: "logs/auth.log", content: "synthetic auth" },
  { name: "scheduled/cron", content: "synthetic cron" },
];
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe("golden scenarios", () => {
  it("complete (tar.gz)", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete" });
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("verified"); expect(r.completeness).toBe("complete");
    expect(r.totals.hashMatch).toBe(5); expect(r.parts.every((p) => p.hashStatus === "match")).toBe(true);
  });
  it("complete (zip parts, Windows layout)", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete", zip: true, targetOs: "windows" });
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("verified"); expect(r.completeness).toBe("complete");
  });
  it("partial: failures/limit skips -> integrity verified but completeness partial", async () => {
    const d = tmp();
    buildSynthRun(d, { state: "partial", files: [...F.slice(0, 3), { name: "x", content: "", outcome: "failed", error: "Permission denied", artifactId: "lin.logs.auth" }, { name: "y", content: "", outcome: "skipped", skipReason: "limit:per-file-bytes (9 > 1)" }] });
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("verified"); expect(r.completeness).toBe("partial");
    expect(r.coverage.find((c) => c.artifactId === "lin.logs.auth")!.failed).toBe(1);
  });
  it("corrupted part -> integrity failed", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete", corruptPart: 1 });
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("failed"); expect(codes(r)).toContain("part-hash-mismatch");
  });
  it("missing part -> integrity failed and completeness incomplete", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete", dropPart: 0 });
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("failed"); expect(r.completeness).toBe("incomplete"); expect(codes(r)).toContain("missing-part"); expect(codes(r)).toContain("missing-members");
  });
  it("interrupted (cancelled) run -> never reported complete", async () => {
    const d = tmp(); buildSynthRun(d, { files: F.slice(0, 2), state: "cancelled" });
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.completeness).toBe("incomplete");
  });
  it("manifest tampering is detected by the external index hash", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete", badManifestHash: true });
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("failed"); expect(codes(r)).toContain("manifest-hash-mismatch");
  });
  it("file content altered but part re-hashed in index is still caught by per-file hashes", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete" });
    // rewrite manifest entry hash to be wrong, then fix index manifest hash so only the file-level check can catch it
    const mp = join(d, "manifest.json"), m = JSON.parse(readFileSync(mp, "utf8")); m.entries[0].sha256 = "a".repeat(64);
    const txt = JSON.stringify(m); writeFileSync(mp, txt);
    const ip = join(d, "retrieval-index.json"), idx = JSON.parse(readFileSync(ip, "utf8")); idx.manifestSha256 = createHash("sha256").update(txt).digest("hex"); writeFileSync(ip, JSON.stringify(idx));
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("failed"); expect(codes(r)).toContain("file-hash-mismatch");
  });
});

describe("schema / input handling", () => {
  it("unknown schema version -> unsupported, not success", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete" });
    const ip = join(d, "retrieval-index.json"), idx = JSON.parse(readFileSync(ip, "utf8")); idx.schemaVersion = 99; writeFileSync(ip, JSON.stringify(idx));
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("unsupported");
  });
  it("malformed index / missing index are visible failures", async () => {
    const d = tmp(); writeFileSync(join(d, "retrieval-index.json"), "{not json");
    expect((await verifyCollection({ files: filesIn(d) })).integrity).toBe("failed");
    expect(codes(await verifyCollection({ files: {} }))).toContain("missing-index");
  });
  it("rejects unsafe imported file names", async () => {
    const r = await verifyCollection({ files: { "../../etc/passwd": "/etc/hosts" } });
    expect(codes(r)).toContain("unsafe-file-name");
  });
  it("plan digest cross-check", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete" });
    expect(codes(await verifyCollection({ files: filesIn(d), planFileSha256: "b".repeat(64) }))).toContain("plan-digest-mismatch");
  });
  it("import size limit", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete" });
    expect(codes(await verifyCollection({ files: filesIn(d), limits: { maxImportBytes: 10 } }))).toContain("import-size-limit");
  });
});

// ---- hostile archives: handcrafted tar members the collector would never produce ----
function tarMember(name: string, data: string, type = "0", linkname = ""): Buffer {
  const h = Buffer.alloc(512); h.write(name, 0, "utf8"); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(Buffer.byteLength(data).toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.write("        ", 148); h.write(type, 156); h.write(linkname, 157); h.write("ustar\0" + "00", 257);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, Buffer.from(data), Buffer.alloc((512 - (Buffer.byteLength(data) % 512)) % 512)]);
}
function runWithMembers(members: Buffer[]) {
  const d = tmp(); const tar = gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]));
  writeFileSync(join(d, "part-001.tar.gz"), tar);
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const manifest = JSON.stringify({ schemaVersion: 1, runId: "run-20261007T000000Z-deadbeef", planId: "plan-0123456789ab", planDigest: sha("p"), catalogVersion: "0.1.0", generatorVersion: "0.1.0", targetOs: "linux",
    host: { name: "h", osVersion: "o", identity: "i", elevated: false }, startedUtc: "s", finishedUtc: null, entries: [] });
  writeFileSync(join(d, "manifest.json"), manifest);
  writeFileSync(join(d, "retrieval-index.json"), JSON.stringify({ schemaVersion: 1, runId: "run-20261007T000000Z-deadbeef", planId: "plan-0123456789ab", planDigest: sha("p"), finalizationState: "complete", manifestName: "manifest.json", manifestSha256: sha(manifest),
    expectedParts: [{ name: "part-001.tar.gz", bytes: tar.length, sha256: sha(tar), members: members.length }], failedParts: [] }));
  return d;
}
describe("hostile archives", () => {
  it.each([
    ["path traversal", "../../etc/evil", "0", "path-traversal"],
    ["absolute path", "/etc/evil", "0", "absolute-path"],
    ["windows drive path", "C:/evil", "0", "absolute-path"],
    ["backslash", "a\\b", "0", "backslash-in-name"],
    ["symlink", "link", "2", "unexpected-member-type"],
    ["hardlink", "link", "1", "unexpected-member-type"],
    ["device", "dev", "3", "unexpected-member-type"],
    ["ambiguous segment", "a//b", "0", "ambiguous-segment"],
    ["control chars", "a\u0001b", "0", "control-characters"],
  ])("rejects %s", async (_n, name, type, code) => {
    const d = runWithMembers([tarMember(name, "x", type)]);
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("failed"); expect(codes(r)).toContain(code);
  });
  it("rejects duplicate members (case-insensitive)", async () => {
    const d = runWithMembers([tarMember("A/b", "1"), tarMember("a/B", "2")]);
    expect(codes(await verifyCollection({ files: filesIn(d) }))).toContain("duplicate-member");
  });
  it("rejects excessive nesting and overlong names", async () => {
    const d = runWithMembers([tarMember(Array(40).fill("d").join("/") + "/f", "x")]);
    expect(codes(await verifyCollection({ files: filesIn(d) }))).toContain("excessive-nesting");
  });
  it("enforces member count and expanded-byte limits (bomb guard)", async () => {
    const d = runWithMembers([tarMember("a", "x"), tarMember("b", "y"), tarMember("c", "z")]);
    expect(codes(await verifyCollection({ files: filesIn(d), limits: { maxMembers: 2 } }))).toContain("member-count-limit");
    expect(codes(await verifyCollection({ files: filesIn(d), limits: { maxExpandedBytes: 600 } }))).toContain("expanded-bytes-limit");
  });
  it("detects truncated archives", async () => {
    const d = tmp(); buildSynthRun(d, { files: F, state: "complete" });
    const p = join(d, "part-001.tar.gz"); const full = readFileSync(p); writeFileSync(p, full.subarray(0, Math.floor(full.length / 2)));
    const r = await verifyCollection({ files: filesIn(d) }); expect(r.integrity).toBe("failed");
  });
  it("does not write anything to disk while verifying (no extraction)", async () => {
    const d = runWithMembers([tarMember("../../../tmp/eec-should-not-exist", "x")]);
    await verifyCollection({ files: filesIn(d) });
    expect(() => readFileSync("/tmp/eec-should-not-exist")).toThrow();
  });
});

describe("report export", () => {
  it("HTML escapes hostile metadata, has a CSP, no scripts and no links", async () => {
    const d = tmp(); buildSynthRun(d, { state: "complete", files: [{ name: "a/b.txt", content: "x", profile: "<script>alert(1)</script>", artifactId: "<img src=x onerror=alert(1)>" }] });
    const r = await verifyCollection({ files: filesIn(d) });
    const html = renderHtmlReport(r, { toolVersion: "t", generatedUtc: "now" });
    expect(html).not.toMatch(/<script|<img|<a /i); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("Content-Security-Policy");
    expect(JSON.parse(summaryJson(r, { toolVersion: "t" })).integrity).toBe("verified");
  });
});

describe("deflate zip parts (system zip utility, if present)", () => {
  it("verifies a real deflate-compressed zip like Windows .NET would produce", async () => {
    const { execFileSync } = await import("node:child_process"); const { existsSync } = await import("node:fs");
    if (!existsSync("/usr/bin/zip")) return;
    const d = tmp(), stage = join(d, "s"); mkdirSync(join(stage, "logs"), { recursive: true }); writeFileSync(join(stage, "logs/a.txt"), "hello hello hello hello".repeat(100));
    execFileSync("/usr/bin/zip", ["-q", "-r", join(d, "part-001.zip"), "logs"], { cwd: stage });
    const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex"); const z = readFileSync(join(d, "part-001.zip"));
    const content = "hello hello hello hello".repeat(100);
    const manifest = JSON.stringify({ schemaVersion: 1, runId: "run-20261007T000000Z-deadbeef", planId: "plan-0123456789ab", planDigest: sha("p"), catalogVersion: "0.1.0", generatorVersion: "0.1.0", targetOs: "windows", host: { name: "h", osVersion: "o", identity: "i", elevated: false }, startedUtc: "s", finishedUtc: null,
      entries: [{ artifactId: "x", profile: null, sourcePath: "s", destination: "logs/a.txt", method: "copy", outcome: "collected", acquiredUtc: "t", bytes: content.length, sha256: sha(content), error: null, skipReason: null, consistencyNote: null, timeFilterApplied: false }] });
    writeFileSync(join(d, "manifest.json"), manifest);
    writeFileSync(join(d, "retrieval-index.json"), JSON.stringify({ schemaVersion: 1, runId: "run-20261007T000000Z-deadbeef", planId: "plan-0123456789ab", planDigest: sha("p"), finalizationState: "complete", manifestName: "manifest.json", manifestSha256: sha(manifest), expectedParts: [{ name: "part-001.zip", bytes: z.length, sha256: sha(z), members: 1 }], failedParts: [] }));
    const r = await verifyCollection({ files: filesIn(d) });
    expect(r.integrity).toBe("verified"); expect(r.totals.hashMatch).toBe(1);
  });
});
void beforeAll;
