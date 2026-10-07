import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { generatePackage, GenerationError, buildConf, assembleCollector } from "@eec/generator";
import { makePlan } from "./helpers/plans.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const text = (r: ReturnType<typeof generatePackage>, n: string) => new TextDecoder().decode(r.files.find((f) => f.name === n)!.data);

describe("generator", () => {
  const plan = makePlan("macos", { artifactIds: ["mac.baseline.system", "mac.volatile.processes"] });
  it("is deterministic: identical plan -> identical archive bytes", () => {
    expect(generatePackage(plan).archiveSha256).toBe(generatePackage(plan).archiveSha256);
  });
  it("package manifest hashes verify against file contents", () => {
    const r = generatePackage(plan);
    for (const m of r.packageManifest.files) { const f = r.files.find((x) => x.name === m.name)!; expect(sha(f.data)).toBe(m.sha256); expect(f.data.length).toBe(m.bytes); }
  });
  it("contains the required files per OS", () => {
    expect(generatePackage(plan).files.map((f) => f.name).sort()).toEqual(["REVIEW-SUMMARY.txt", "RUN-INSTRUCTIONS.txt", "collection-plan.json", "collector.conf", "collector.sh", "package-manifest.json"]);
    const w = generatePackage(makePlan("windows", { artifactIds: ["win.baseline.system"] }));
    expect(w.files.map((f) => f.name)).toContain("collector.ps1"); expect(w.archiveName.endsWith(".zip")).toBe(true);
  });
  it("tar.gz output is a valid gzip stream", () => { expect(gunzipSync(generatePackage(plan).archive).length % 512).toBe(0); });
  it("the collector script does not depend on plan content (same bytes for different plans)", () => {
    const a = generatePackage(plan), b = generatePackage(makePlan("macos", { artifactIds: ["mac.baseline.system"], outputRoot: "/var/tmp/other root" }));
    expect(sha(a.files.find((f) => f.name === "collector.sh")!.data)).toBe(sha(b.files.find((f) => f.name === "collector.sh")!.data));
  });
  it("hostile-looking names/paths stay literal data in conf (never in script)", () => {
    const evil = "bob $(touch pwned) `id` ; rm -rf 'q' é日本 &";
    const p = makePlan("linux", { artifactIds: ["lin.baseline.system"], userScope: { mode: "named", names: [evil] }, outputRoot: "/var/tmp/eec out ; x" });
    const r = generatePackage(p);
    expect(text(r, "collector.conf")).toContain("user_name\t" + evil);
    expect(text(r, "collector.sh")).not.toContain("pwned");
    expect(text(r, "collection-plan.json")).toContain("pwned"); // as JSON data only
  });
  it("conf builder refuses control characters", () => {
    const p = { ...makePlan("linux", { artifactIds: ["lin.baseline.system"] }), customPaths: ["/tmp/a\nb"] };
    expect(() => buildConf(p, "0".repeat(64))).toThrow(/control characters/);
  });
  it("refuses plans that fail validation, with operator-readable issues", () => {
    expect(() => generatePackage({ ...plan, outputRoot: "/" })).toThrow(GenerationError);
  });
  it("refuses planned-only collectors (no executable package for them)", () => {
    expect(() => generatePackage(makePlan("windows", { artifactIds: ["win.registry.broad"] }))).toThrow(/only planned/);
  });
  it("requires explicit sensitive selection for command lines, and the dependency", () => {
    expect(() => generatePackage(makePlan("linux", { artifactIds: ["lin.volatile.processes", "lin.volatile.processes.cmdline"] }))).toThrow(/process-command-lines/);
    expect(() => generatePackage(makePlan("linux", { artifactIds: ["lin.volatile.processes.cmdline"], sensitiveSelections: ["process-command-lines"] }))).toThrow(/dependencies/);
    expect(generatePackage(makePlan("linux", { artifactIds: ["lin.volatile.processes", "lin.volatile.processes.cmdline"], sensitiveSelections: ["process-command-lines"] })).files.length).toBeGreaterThan(0);
  });
  it("rejects wrong-OS artifacts and stale catalog versions", () => {
    expect(() => generatePackage(makePlan("linux", { artifactIds: ["mac.baseline.system"] }))).toThrow(/does not apply/);
    expect(() => generatePackage(makePlan("linux", { artifactIds: ["lin.baseline.system"], catalogVersion: "9.9.9" }))).toThrow(/catalog/);
  });
  it("discloses unverified collectors in run instructions and never claims verified", () => {
    const r = generatePackage(plan); expect(r.unverified.length).toBe(2);
    expect(text(r, "RUN-INSTRUCTIONS.txt")).toContain("SUPPORT DISCLOSURE");
  });
  it("instructions never recommend execution-policy bypass, and quote paths", () => {
    const w = text(generatePackage(makePlan("windows", { artifactIds: ["win.baseline.system"] })), "RUN-INSTRUCTIONS.txt");
    expect(w).not.toMatch(/-ExecutionPolicy\s+Bypass/i); expect(w).toContain("-NoProfile -NonInteractive -File \"");
  });
  it("background instructions appear only when requested and are labelled unvalidated", () => {
    expect(text(generatePackage(plan), "RUN-INSTRUCTIONS.txt")).not.toContain("Background launch");
    expect(text(generatePackage({ ...plan, executionMode: "background" }), "RUN-INSTRUCTIONS.txt")).toContain("NOT VALIDATED");
  });
});

describe("collector template static safety review", () => {
  const forbidden: [RegExp, string][] = [[/\beval\b/, "eval"], [/Invoke-Expression|\biex\b/i, "Invoke-Expression"], [/\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Start-BitsTransfer/i, "networking"],
    [/ExecutionPolicy/i, "execution policy"], [/schtasks\s*\/create|Register-ScheduledTask|launchctl\s+(load|bootstrap)|systemctl\s+(enable|start)|(?<![\/\w])crontab\s+(-(?!l\b)|[A-Za-z\/.])/i, "persistence (only read-only crontab -l is allowed)"], [/(^|[;&|(]\s*)sudo\s|\brunas\b|Start-Process.*-Verb\s+RunAs/i, "elevation"],
    [/csrutil|tccutil|sqlite3\s+.*TCC|Set-MpPreference|spctl\s+--master-disable/i, "protection tampering"]];
  for (const os of ["windows", "macos", "linux"] as const) {
    const src = assembleCollector(os);
    it.each(forbidden)(`${os} collector has no %s (${os})`, (re) => { const lines = src.split("\n").filter((l) => !/^\s*#/.test(l)); expect(lines.filter((l) => re.test(l))).toEqual([]); });
  }
  it("browser helpers never reference credential/cookie stores", () => {
    const s = assembleCollector("macos") + assembleCollector("linux") + assembleCollector("windows");
    const code = s.split("\n").filter((l) => !/^\s*#/.test(l) && !/note|NOTE|never|NEVER/.test(l)).join("\n");
    for (const w of ["Login Data", "logins.json", "key4.db", "cookies.sqlite", "Web Data"]) expect(code).not.toContain(w);
  });
});
