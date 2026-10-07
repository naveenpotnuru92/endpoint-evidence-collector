import { describe, it, expect } from "vitest";
import { validatePlan, checkLiteralPath, checkOutputRoot } from "@eec/schema";
import { makePlan } from "./helpers/plans.ts";

const issues = (p: unknown) => { const r = validatePlan(p); return r.ok ? [] : r.issues; };

describe("plan schema", () => {
  it("accepts a valid plan", () => {
    expect(validatePlan(makePlan("linux", { artifactIds: ["lin.baseline.system"] })).ok).toBe(true);
  });
  it("rejects unknown top-level fields (strict) — no raw commands can be smuggled", () => {
    const p = { ...makePlan("linux", { artifactIds: ["lin.baseline.system"] }), command: "rm -rf /" };
    expect(issues(p).length).toBeGreaterThan(0);
  });
  it("rejects inverted and half-open time ranges", () => {
    const base = makePlan("macos", { artifactIds: ["mac.baseline.system"] });
    const inverted = { ...base, timeWindow: { mode: "range", days: null, startUtc: "2026-10-07T00:00:00Z", endUtc: "2026-10-01T00:00:00Z", displayTimezone: "UTC" } };
    expect(issues(inverted).some((i) => /inverted/.test(i.message))).toBe(true);
    const half = { ...base, timeWindow: { mode: "range", days: null, startUtc: "2026-10-01T00:00:00Z", endUtc: null, displayTimezone: "UTC" } };
    expect(issues(half).length).toBeGreaterThan(0);
  });
  it("enforces mutually exclusive user-scope fields", () => {
    const base = makePlan("macos", { artifactIds: ["mac.baseline.system"] });
    expect(issues({ ...base, userScope: { mode: "named", names: [] } }).length).toBeGreaterThan(0);
    expect(issues({ ...base, userScope: { mode: "all-normal", names: ["alice"] } }).length).toBeGreaterThan(0);
  });
  it("rejects per-file > total and zero selection", () => {
    const base = makePlan("linux", { artifactIds: ["lin.baseline.system"] });
    expect(issues({ ...base, sizeLimits: { ...base.sizeLimits, perFileBytes: base.sizeLimits.totalBytes + 1 } }).length).toBeGreaterThan(0);
    expect(issues(makePlan("linux")).length).toBeGreaterThan(0);
  });
  it("rejects bad plan IDs / injection in IDs", () => {
    expect(issues({ ...makePlan("linux", { artifactIds: ["lin.baseline.system"] }), planId: "plan-1; rm -rf /" }).length).toBeGreaterThan(0);
    expect(issues(makePlan("linux", { artifactIds: ["lin.baseline.system; id"] })).length).toBeGreaterThan(0);
  });
});

describe("path validation", () => {
  const bad: [string, "windows" | "macos" | "linux"][] = [
    ["/etc/../etc/passwd", "linux"], ["relative/path", "linux"], ["/tmp/a*b", "linux"], ["/tmp/$(id)", "linux"], ["/tmp/`id`", "linux"], ["/tmp/~x/~", "macos"],
    ["/tmp/new\nline", "linux"], ["/tmp/tab\t", "linux"], ["//server/share", "linux"],
    ["\\\\server\\share\\x", "windows"], ["C:\\a\\..\\b", "windows"], ["C:\\a\\b*.txt", "windows"], ["C:\\a:stream", "windows"], ["C:\\CON", "windows"], ["relative\\x", "windows"], ["C:\\dir.\\x", "windows"],
  ];
  it.each(bad)("rejects %j on %s", (p, os) => { expect(checkLiteralPath(p, os)).not.toBeNull(); });
  it("accepts spaces and Unicode in literal paths", () => {
    expect(checkLiteralPath("/var/tmp/José Müller/日本語 file.txt", "linux")).toBeNull();
    expect(checkLiteralPath("C:\\Users\\José Müller\\notes.txt", "windows")).toBeNull();
  });
  it.each([["/", "linux"], ["/etc", "linux"], ["/var/log", "linux"], ["/var/log/eec", "macos"], ["C:\\", "windows"], ["C:\\Windows", "windows"], ["C:\\Windows\\System32\\winevt\\x", "windows"], ["/Users", "macos"]] as const)(
    "rejects unsafe output root %s on %s", (p, os) => { expect(checkOutputRoot(p, os)).not.toBeNull(); });
  it("accepts dedicated roots", () => {
    expect(checkOutputRoot("/var/tmp/eec", "linux")).toBeNull();
    expect(checkOutputRoot("C:\\IR\\Evidence", "windows")).toBeNull();
  });
  it("rejects custom paths that overlap the output root", () => {
    const p = makePlan("linux", { artifactIds: ["lin.baseline.system"], customPaths: ["/var/tmp/eec-evidence/run-x/file"] });
    expect(issues(p).some((i) => /overlaps the output root/.test(i.message))).toBe(true);
  });
});
