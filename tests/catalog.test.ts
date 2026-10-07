import { describe, it, expect } from "vitest";
import { ARTIFACTS, CATEGORIES, PRESETS_DEF, searchCatalog, resolveSelection, groupSelectAll, artifactsForOs, getArtifact } from "@eec/catalog";
import { OS_LIST } from "@eec/schema";

describe("catalog contract", () => {
  it("has unique IDs and every artifact has a known category and OS-consistent ID prefix", () => {
    const ids = ARTIFACTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prefix = { windows: "win.", macos: "mac.", linux: "lin." } as const;
    for (const a of ARTIFACTS) {
      expect(CATEGORIES.some((c) => c.id === a.category)).toBe(true);
      expect(a.os.length).toBe(1);
      expect(a.id.startsWith(prefix[a.os[0]!])).toBe(true);
      expect(a.dependsOn.every((d) => getArtifact(d))).toBe(true);
    }
  });
  it("never lists credential/session stores as collectable artifacts", () => {
    const text = JSON.stringify(ARTIFACTS.map((a) => [a.id, a.output]));
    for (const forbidden of ["Cookies", "Login Data", "logins.json", "key4.db", "cookies.sqlite", "Web Data", "SAM", "lsass"]) expect(text).not.toContain(forbidden);
  });
  it("presets never include sensitive-option artifacts and only reference same-OS IDs", () => {
    for (const p of PRESETS_DEF) for (const os of OS_LIST) for (const id of p.artifactIdsByOs[os]) {
      const a = getArtifact(id)!; expect(a, id).toBeTruthy(); expect(a.os).toContain(os); expect(a.sensitivity).not.toBe("sensitive-option");
    }
  });
  it("quick triage contains no browser data", () => {
    const qt = PRESETS_DEF.find((p) => p.id === "quick-triage")!;
    for (const os of OS_LIST) expect(qt.artifactIdsByOs[os].some((i) => getArtifact(i)!.category === "browser")).toBe(false);
  });
  it("registry exists only on Windows; launchd only on macOS", () => {
    expect(artifactsForOs("macos").some((a) => a.category === "registry")).toBe(false);
    expect(artifactsForOs("linux").some((a) => a.category === "registry")).toBe(false);
    expect(artifactsForOs("windows").some((a) => a.id.includes("launchd"))).toBe(false);
    expect(artifactsForOs("linux").some((a) => a.id.includes("launchd"))).toBe(false);
  });
  it("no artifact is marked verified without target-OS testing (honest status)", () => {
    for (const a of ARTIFACTS) for (const s of Object.values(a.status)) expect(s).not.toBe("verified");
  });
});

describe("search", () => {
  it("maps aliases per OS", () => {
    expect(searchCatalog("registry", "windows").hits.length).toBeGreaterThan(0);
    expect(searchCatalog("registry", "macos").noMatch).toBe(true);
    expect(searchCatalog("cron", "linux").hits.some((h) => h.artifact.id === "lin.scheduled.cron")).toBe(true);
    expect(searchCatalog("scheduled", "windows").hits.some((h) => h.artifact.id === "win.scheduled.tasks")).toBe(true);
    expect(searchCatalog("launchd", "macos").hits.some((h) => h.artifact.id === "mac.scheduled.launchd")).toBe(true);
  });
  it("unknown terms produce an honest no-match and never expand scope", () => {
    const r = searchCatalog("quantum flux capacitor", "windows");
    expect(r.noMatch).toBe(true); expect(r.hits).toHaveLength(0);
  });
  it("empty query is not a no-match", () => { expect(searchCatalog("  ", "linux").noMatch).toBe(false); });
  it("reports why a hit matched", () => { expect(searchCatalog("chrome history", "windows").hits[0]!.matchedOn).toMatch(/alias|name/); });
});

describe("selection", () => {
  it("auto-adds dependencies transparently", () => {
    const r = resolveSelection(["win.volatile.processes.cmdline"], "windows");
    expect(r.ids).toContain("win.volatile.processes");
    expect(r.autoAdded).toEqual([{ id: "win.volatile.processes", requiredBy: "win.volatile.processes.cmdline" }]);
  });
  it("does not report explicitly selected deps as auto-added", () => {
    expect(resolveSelection(["win.volatile.processes", "win.volatile.processes.cmdline"], "windows").autoAdded).toHaveLength(0);
  });
  it("flags wrong-OS and unknown IDs", () => {
    const r = resolveSelection(["mac.baseline.system", "nope.x"], "linux");
    expect(r.wrongOs).toEqual(["mac.baseline.system"]); expect(r.unknown).toEqual(["nope.x"]);
  });
  it("group select-all never silently selects sensitive subgroups", () => {
    for (const os of OS_LIST) expect(groupSelectAll("volatile", os).some((i) => getArtifact(i)!.sensitivity === "sensitive-option")).toBe(false);
  });
});
