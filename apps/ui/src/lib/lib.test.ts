import { describe, it, expect } from "vitest";
import { zonedToUtcIso, tzOffsetMs, isValidTz } from "./time";
import { newDraft, toPlan, validateDraft, presetDiff, fieldForPath, DEFAULT_OUTPUT } from "./draft";

describe("timezone conversion", () => {
  it("UTC is identity", () => expect(zonedToUtcIso("2026-10-07T12:30", "UTC")).toBe("2026-10-07T12:30:00Z"));
  it("applies zone offsets incl. DST (New York: EDT -4 in Oct, EST -5 in Dec)", () => {
    expect(zonedToUtcIso("2026-10-07T12:00", "America/New_York")).toBe("2026-10-07T16:00:00Z");
    expect(zonedToUtcIso("2026-12-07T12:00", "America/New_York")).toBe("2026-12-07T17:00:00Z");
  });
  it("half-hour zones (Kolkata +5:30)", () => expect(zonedToUtcIso("2026-10-07T12:00", "Asia/Kolkata")).toBe("2026-10-07T06:30:00Z"));
  it("rejects garbage and bad zones", () => { expect(zonedToUtcIso("nope", "UTC")).toBeNull(); expect(isValidTz("Mars/Base")).toBe(false); expect(zonedToUtcIso("2026-10-07T12:00", "Mars/Base")).toBeNull(); });
  it("offset helper", () => expect(tzOffsetMs(Date.UTC(2026, 6, 1), "America/New_York")).toBe(-4 * 3600_000));
});

describe("draft → plan", () => {
  const ready = () => ({ ...newDraft(), os: "linux" as const, outputRoot: DEFAULT_OUTPUT.linux, artifactIds: ["lin.baseline.system"] });
  it("a minimal ready draft validates", () => expect(validateDraft(ready()).plan).not.toBeNull());
  it("no OS → issue on the os field, no plan", () => { const r = validateDraft({ ...ready(), os: null }); expect(r.plan).toBeNull(); expect(r.issues[0]!.path).toBe("os"); });
  it("inverted range gets a schema error mapped to endLocal", () => {
    const r = validateDraft({ ...ready(), timeMode: "range", startLocal: "2026-10-07T00:00", endLocal: "2026-10-01T00:00" });
    const i = r.issues.find((x) => /inverted/.test(x.message))!; expect(fieldForPath(i.path).field).toBe("endLocal");
  });
  it("non-numeric limits are reported by field", () => { const r = validateDraft({ ...ready(), totalGiB: "abc" }); expect(r.issues.some((i) => i.path === "totalGiB")).toBe(true); });
  it("hostile custom path text stays a literal string in the plan", () => {
    const p = toPlan({ ...ready(), customPathsText: "/tmp/$(id)\n  /tmp/ok file  " }) as { customPaths: string[] }; expect(p.customPaths).toEqual(["/tmp/$(id)", "/tmp/ok file"]);
    expect(validateDraft({ ...ready(), customPathsText: "/tmp/$(id)" }).plan).toBeNull();
  });
  it("command-line artifact implies the explicit sensitive selection", () => {
    const p = toPlan({ ...ready(), artifactIds: ["lin.volatile.processes", "lin.volatile.processes.cmdline"] }) as { sensitiveSelections: string[] }; expect(p.sensitiveSelections).toEqual(["process-command-lines"]);
  });
  it("preset diff previews additions and removals instead of replacing silently", () => {
    const d = { ...ready(), artifactIds: ["lin.logs.journal"] }; const diff = presetDiff(d, "quick-triage");
    expect(diff.remove).toEqual(["lin.logs.journal"]); expect(diff.add.length).toBeGreaterThan(3);
  });
  it("targeted preset never changes selection", () => expect(presetDiff(ready(), "targeted")).toEqual({ add: [], remove: [] }));
});
