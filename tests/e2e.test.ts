// END-TO-END: plan -> generator -> real collector script -> retrieval files -> verifier -> report.
// Runs the actual Unix collector against SYNTHETIC fixture homes on this (macOS or Linux) host, writing only to temp dirs.
// Windows collector cannot run here (no PowerShell/Windows) — it is only statically reviewed (see docs/support-matrix.md).
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePackage } from "@eec/generator";
import { verifyCollection, renderHtmlReport } from "@eec/verifier";
import { makePlan, makeFixtureUsers } from "./helpers/plans.ts";
import { filesIn } from "./helpers/synth-run.ts";
import type { Plan } from "@eec/schema";

const HOST = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
const P = HOST === "macos" ? "mac" : "lin";
const BROWSER_HIST = `${P}.browser.chromium.history`, FF_HIST = `${P}.browser.firefox.history`, USERLOGS = `${P}.userlogs.user`;

interface RunOut { code: number; stderr: string; runDir: string; pkgDir: string; outRoot: string }
function runCollector(plan: Plan, opts: { users?: string; tamper?: (pkgDir: string) => void; args?: string[]; signalAfterMs?: number } = {}): Promise<RunOut> {
  const pkgDir = mkdtempSync(join(tmpdir(), "eec-pkg-"));
  const pkg = generatePackage(plan);
  for (const f of pkg.files) writeFileSync(join(pkgDir, f.name), f.data);
  opts.tamper?.(pkgDir);
  return new Promise((resolve) => {
    const c = spawn("/bin/bash", [join(pkgDir, "collector.sh"), ...(opts.args ?? ["--run"])], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, EEC_TEST_USERS_ROOT: opts.users ?? "" }, cwd: pkgDir });
    let err = ""; c.stderr.on("data", (d) => (err += d)); c.stdout.on("data", () => {});
    if (opts.signalAfterMs) setTimeout(() => c.kill("SIGTERM"), opts.signalAfterMs);
    c.on("close", (code) => resolve({ code: code ?? -1, stderr: err, runDir: /RUN_DIR=(.*)/.exec(err)?.[1] ?? "", pkgDir, outRoot: plan.outputRoot }));
  });
}
const mkOut = () => mkdtempSync(join(tmpdir(), "eec-out-"));

describe.runIf(HOST !== null)("end-to-end (host: " + HOST + ")", () => {
  let users: string;
  beforeAll(() => { users = makeFixtureUsers(); });
  const base = (over: Partial<Plan> = {}) => makePlan(HOST!, { outputRoot: mkOut(), artifactIds: [BROWSER_HIST, FF_HIST, USERLOGS], ...over });

  it("complete run: collects only selected artifacts, all users & nested profiles, verifies clean", async () => {
    const out = await runCollector(base(), { users });
    expect(out.code).toBe(0);
    expect(existsSync(join(out.runDir, "FINALIZED"))).toBe(true);
    expect(existsSync(join(out.runDir, ".staging"))).toBe(false);                 // plaintext staging removed
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.integrity).toBe("verified"); expect(r.completeness).toBe("complete");
    const dests = r.entries.map((e) => e.destination);
    const hist = dests.filter((d) => /History$/.test(d));
    if (HOST === "macos") { expect(hist.some((d) => d.includes("alice/Chrome/Default"))).toBe(true); expect(hist.some((d) => d.includes("alice/Chrome/Profile_2"))).toBe(true); }
    expect(hist.some((d) => d.includes("bob_"))).toBe(true);                       // hostile name sanitized, still collected
    expect(dests.some((d) => /Cookies|Login Data|logins\.json|key4\.db/.test(d))).toBe(false);
    expect(r.entries.every((e) => e.hashStatus === "match" || e.hashStatus === "not-applicable")).toBe(true);
    // artifacts that were not selected must not appear
    expect(r.entries.some((e) => e.artifactId.includes("baseline") || e.artifactId.includes("launchd"))).toBe(false);
    // hostile profile name must not have been executed
    expect(existsSync(join(process.cwd(), "pwned"))).toBe(false); expect(existsSync(join(out.pkgDir, "pwned"))).toBe(false);
    // report
    expect(renderHtmlReport(r, { toolVersion: "t", generatedUtc: "now" })).toContain("Integrity verified");
  });

  it("run directory and files are owner-only (0700 / no group-other bits)", async () => {
    const out = await runCollector(base(), { users });
    expect(statSync(out.runDir).mode & 0o077).toBe(0);
    for (const n of readdirSync(out.runDir)) expect(statSync(join(out.runDir, n)).mode & 0o077, n).toBe(0);
  });

  it("status.json final state agrees with the index, and a second run never reuses/overwrites the first", async () => {
    const plan = base(); const a = await runCollector(plan, { users }); const b = await runCollector(plan, { users });
    expect(a.runDir).not.toBe(b.runDir);
    const idx = JSON.parse(readFileSync(join(a.runDir, "retrieval-index.json"), "utf8")); const st = JSON.parse(readFileSync(join(a.runDir, "status.json"), "utf8"));
    expect(st.state).toBe(idx.finalizationState); expect(existsSync(join(a.runDir, "manifest.json"))).toBe(true);
  });

  it("named scope collects only that account and reports a missing account", async () => {
    const out = await runCollector(base({ userScope: { mode: "named", names: ["alice", "ghost"] } }), { users });
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.entries.some((e) => e.destination.includes("bob"))).toBe(false);
    expect(r.entries.some((e) => e.skipReason === "named-account-not-found" && e.profile === "ghost")).toBe(true);
  });

  it("interactive scope with no/multiple matching users collects nothing per-user and says so (no guessing)", async () => {
    const out = await runCollector(base({ userScope: { mode: "interactive", names: [] } }), { users });
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.entries.filter((e) => e.outcome === "collected")).toHaveLength(0);
    expect(r.entries.some((e) => e.skipReason.startsWith("interactive-users:"))).toBe(true);
    expect(r.completeness).toBe("partial");
  });

  it("per-file limit: oversize source is skipped with a deterministic reason, never truncated", async () => {
    const u = makeFixtureUsers(); const big = join(u, "alice", HOST === "macos" ? "Library/Logs/big.log" : ".local/state/big.log");
    mkdirSync(join(big, ".."), { recursive: true }); writeFileSync(big, "A".repeat(4096));
    const plan = base(); plan.sizeLimits = { ...plan.sizeLimits, perFileBytes: 2048 };
    const out = await runCollector(plan, { users: u });
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    const skipped = r.entries.find((e) => e.skipReason.startsWith("limit:per-file-bytes"))!;
    expect(skipped).toBeTruthy(); expect(skipped.destination).toBe("");
    expect(r.completeness).toBe("partial"); expect(r.integrity).toBe("verified"); expect(out.code).toBe(10);
  });

  it("archive part limit splits output into independently verifiable parts", async () => {
    const u = makeFixtureUsers(); for (let i = 0; i < 6; i++) writeFileSync(join(u, "alice", HOST === "macos" ? "Library/Logs/" : ".local/state/" ) + `f${i}.log`, "B".repeat(400000)) ;
    const plan = base({ userScope: { mode: "named", names: ["alice"] } }); plan.sizeLimits = { ...plan.sizeLimits, archivePartBytes: 1024 * 1024 };
    mkdirSync(join(u, "alice", HOST === "macos" ? "Library/Logs" : ".local/state"), { recursive: true });
    for (let i = 0; i < 6; i++) writeFileSync(join(u, "alice", HOST === "macos" ? "Library/Logs" : ".local/state", `f${i}.log`), "B".repeat(400000));
    const out = await runCollector(plan, { users: u });
    const parts = readdirSync(out.runDir).filter((n) => n.startsWith("part-"));
    expect(parts.length).toBeGreaterThan(1);
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.integrity).toBe("verified"); expect(r.parts.length).toBe(parts.length);
  });

  it("custom path: literal path with spaces/Unicode collected; symlink not followed; missing recorded", async () => {
    const d = mkdtempSync(join(tmpdir(), "eec-custom-")); const f = join(d, "ünï cödé file.txt"); writeFileSync(f, "synthetic"); symlinkSync(f, join(d, "link.txt"));
    const out = await runCollector(base({ artifactIds: [FF_HIST], customPaths: [f, join(d, "link.txt"), join(d, "missing.txt")] }), { users });
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    const c = r.entries.filter((e) => e.artifactId === "custom");
    expect(c.find((e) => e.outcome === "collected")).toBeTruthy();
    expect(c.find((e) => e.skipReason === "symlink-not-followed")).toBeTruthy();
    expect(c.find((e) => e.skipReason === "source-not-present")).toBeTruthy();
  });

  it("volatile snapshot without sensitive grant never records command lines", async () => {
    const out = await runCollector(base({ artifactIds: [`${P}.volatile.processes`] }), { users });
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.integrity).toBe("verified"); expect(r.entries.some((e) => e.destination.includes("cmdline"))).toBe(false);
    expect(r.entries.find((e) => e.destination === "volatile/processes.txt")!.outcome).toBe("collected");
  });

  it("cron fallback: unreadable system crontabs fall back to the caller's own crontab and are labelled FALLBACK (no elevation)", async () => {
    if (process.getuid?.() === 0) return;
    const out = await runCollector(base({ artifactIds: [`${P}.scheduled.cron`], userScope: { mode: "named", names: ["alice"] } }), { users });
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    const fb = r.entries.filter((e) => e.artifactId.endsWith("scheduled.cron") && (e.note.startsWith("FALLBACK") || e.skipReason.startsWith("fallback-")));
    expect(fb.length).toBeGreaterThan(0);                                    // fallback was attempted and recorded either way
    expect(r.entries.some((e) => e.note.startsWith("FALLBACK") && e.hashStatus !== "match")).toBe(false);
    if (r.entries.some((e) => e.note.startsWith("FALLBACK"))) expect(r.findings.some((f) => f.code === "fallback-used")).toBe(true);
  });

  it("baseline snapshot works and records identity/elevation", async () => {
    const out = await runCollector(base({ artifactIds: [`${P}.baseline.system`] }), { users });
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.completeness).toBe("complete"); expect(r.run!.identity.length).toBeGreaterThan(0); expect(r.run!.elevated).toBe(process.getuid?.() === 0);
  });

  it("preflight-only does not create any run directory", async () => {
    const plan = base(); const out = await runCollector(plan, { users, args: ["--preflight-only"] });
    expect(out.code).toBe(0); expect(readdirSync(plan.outputRoot).filter((n) => n.startsWith("run-"))).toHaveLength(0);
  });

  it("preflight failure (exit 20): tampered plan digest", async () => {
    const plan = base(); const out = await runCollector(plan, { users, tamper: (d) => writeFileSync(join(d, "collection-plan.json"), readFileSync(join(d, "collection-plan.json"), "utf8") + " ") });
    expect(out.code).toBe(20); expect(out.stderr).toContain("digest"); expect(readdirSync(plan.outputRoot)).toHaveLength(0);
  });

  it("preflight failure (exit 20): plan for a different OS", async () => {
    const other = HOST === "macos" ? "linux" : "macos";
    const plan = makePlan(other, { outputRoot: mkOut(), artifactIds: [other === "macos" ? "mac.baseline.system" : "lin.baseline.system"] });
    const out = await runCollector(plan, { users }); expect(out.code).toBe(20); expect(out.stderr).toMatch(/plan targets/);
  });

  it("preflight failure (exit 20): output root is a symlink", async () => {
    const real = mkOut(); const link = join(mkOut(), "lnk"); symlinkSync(real, link);
    const out = await runCollector(base({ outputRoot: link }), { users }); expect(out.code).toBe(20); expect(out.stderr).toContain("symlink");
  });

  it("preflight failure (exit 20): unusable config", async () => {
    const out = await runCollector(base(), { users, tamper: (d) => writeFileSync(join(d, "collector.conf"), "plan_id\tx\n") });
    expect(out.code).toBe(20);
  });

  it("interrupted run (SIGTERM): finalizes, exit 30, never reported complete", async () => {
    const u = makeFixtureUsers(); const dir = join(u, "alice", HOST === "macos" ? "Library/Logs" : ".local/state"); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1500; i++) writeFileSync(join(dir, `f${i}.log`), "x" + i);
    const out = await runCollector(base({ userScope: { mode: "named", names: ["alice"] } }), { users: u, signalAfterMs: 2500 });
    expect(out.code).toBe(30);
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.integrity).toBe("verified"); expect(r.completeness).toBe("incomplete"); expect(r.run!.finalizationState).toBe("cancelled");
    expect(JSON.parse(readFileSync(join(out.runDir, "status.json"), "utf8")).failureSummary.join(" ")).toMatch(/interrupted/);
  });

  describe("cleanup", () => {
    it("refuses without --yes, refuses non-run dirs and symlinks, then removes only a valid owned run dir", async () => {
      const out = await runCollector(base(), { users });
      const sh = join(out.pkgDir, "collector.sh"); const run = (...a: string[]) => spawnSync("/bin/bash", [sh, ...a], { encoding: "utf8" });
      expect(run("--cleanup", out.runDir).status).toBe(2); expect(existsSync(out.runDir)).toBe(true);
      const decoy = join(mkOut(), "important"); mkdirSync(decoy); writeFileSync(join(decoy, "keep.txt"), "k");
      expect(run("--cleanup", decoy, "--yes").status).toBe(2); expect(existsSync(join(decoy, "keep.txt"))).toBe(true);
      const sneaky = join(mkOut(), "run-20261007T000000Z-deadbeef"); mkdirSync(sneaky); writeFileSync(join(sneaky, "keep.txt"), "k");   // right name, no ownership marker
      expect(run("--cleanup", sneaky, "--yes").status).toBe(2); expect(existsSync(join(sneaky, "keep.txt"))).toBe(true);
      const lnk = join(mkOut(), "lnk"); symlinkSync(out.runDir, lnk); expect(run("--cleanup", lnk, "--yes").status).toBe(2); expect(existsSync(out.runDir)).toBe(true);
      expect(run("--cleanup", "/", "--yes").status).toBe(2);
      expect(run("--cleanup", out.runDir, "--yes").status).toBe(0); expect(existsSync(out.runDir)).toBe(false);
    });
  });

  it("unreadable source is recorded as failed (not silently dropped)", async () => {
    if (process.getuid?.() === 0) return;   // root ignores permissions
    const u = makeFixtureUsers(); const h = join(u, "alice", HOST === "macos" ? "Library/Application Support/Google/Chrome/Default/History" : ".config/google-chrome/Default/History");
    chmodSync(h, 0o000);
    const out = await runCollector(base({ userScope: { mode: "named", names: ["alice"] } }), { users: u });
    chmodSync(h, 0o644);
    const r = await verifyCollection({ files: filesIn(out.runDir) });
    expect(r.entries.some((e) => e.outcome === "failed" && /Permission denied/.test(e.error))).toBe(true); expect(r.completeness).toBe("partial");
  });

  it("verifier detects tampering with a retrieved part after a real run", async () => {
    const out = await runCollector(base(), { users }); const part = join(out.runDir, "part-001.tar.gz");
    const b = readFileSync(part); b[Math.floor(b.length / 2)] ^= 0xff; writeFileSync(part, b);
    expect((await verifyCollection({ files: filesIn(out.runDir) })).integrity).toBe("failed");
  });
  void rmSync;
});
