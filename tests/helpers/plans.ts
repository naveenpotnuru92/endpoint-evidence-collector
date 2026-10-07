// Shared test helpers: build valid plans and synthetic fixture homes. No real personal data anywhere.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, GENERATOR_VERSION, type Plan, type TargetOs } from "@eec/schema";
import { CATALOG_VERSION } from "@eec/catalog";

export function makePlan(os: TargetOs, over: Partial<Plan> = {}): Plan {
  const outputRoot = os === "windows" ? "C:\\IR\\Evidence" : "/var/tmp/eec-evidence";
  return {
    schemaVersion: 1, catalogVersion: CATALOG_VERSION, generatorVersion: GENERATOR_VERSION,
    planId: "plan-0123456789ab", createdAtUtc: "2026-10-07T00:00:00Z", targetOs: os, preset: "targeted",
    artifactIds: [], userScope: { mode: "all-normal", names: [] }, includeSystemProfiles: false,
    timeWindow: { mode: "last-days", days: 7, startUtc: null, endUtc: null, displayTimezone: "UTC" },
    outputRoot, sizeLimits: { ...DEFAULT_LIMITS }, runtimeBudgetSeconds: 900, customPaths: [], sensitiveSelections: [], executionMode: "foreground",
    ...over,
  };
}

/** Synthetic multi-user fixture: two normal users, nested Chrome profiles, a Firefox profile, awkward names. */
export function makeFixtureUsers(): string {
  const root = mkdtempSync(join(tmpdir(), "eec-fixture-users-"));
  const w = (p: string, c: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, c); };
  const alice = join(root, "alice");
  w(join(alice, "Library/Application Support/Google/Chrome/Default/History"), "SYNTHETIC-HISTORY-alice-default");
  w(join(alice, "Library/Application Support/Google/Chrome/Default/History-wal"), "SYNTHETIC-WAL");
  w(join(alice, "Library/Application Support/Google/Chrome/Default/Preferences"), "{}");
  w(join(alice, "Library/Application Support/Google/Chrome/Default/Cookies"), "MUST-NEVER-BE-COLLECTED");
  w(join(alice, "Library/Application Support/Google/Chrome/Default/Login Data"), "MUST-NEVER-BE-COLLECTED");
  w(join(alice, "Library/Application Support/Google/Chrome/Profile 2/History"), "SYNTHETIC-HISTORY-alice-profile2");
  w(join(alice, "Library/Application Support/Google/Chrome/Default/Extensions/abcd/1.0/manifest.json"), '{"name":"synthetic"}');
  w(join(alice, "Library/Application Support/Firefox/Profiles/xyz.default/places.sqlite"), "SYNTHETIC-FF");
  w(join(alice, "Library/Application Support/Firefox/Profiles/xyz.default/logins.json"), "MUST-NEVER-BE-COLLECTED");
  w(join(alice, "Library/Application Support/Firefox/Profiles/xyz.default/prefs.js"), "// prefs");
  w(join(alice, "Library/LaunchAgents/com.example.synthetic.plist"), "<plist/>");
  w(join(alice, "Library/Logs/app.log"), "synthetic log");
  const bob = join(root, "bob $(touch pwned) 'smith'");   // hostile-looking literal name
  w(join(bob, "Library/Application Support/Google/Chrome/Default/History"), "SYNTHETIC-HISTORY-bob");
  w(join(bob, "Library/LaunchAgents/evil;name.plist"), "<plist/>");
  // Linux layout (same users) so the same fixture drives both Unix collectors.
  for (const [u, h] of [[alice, "alice"], [bob, "bob"]] as const) {
    w(join(u, ".config/google-chrome/Default/History"), "SYNTHETIC-HISTORY-linux-" + h);
    w(join(u, ".config/google-chrome/Default/Cookies"), "MUST-NEVER-BE-COLLECTED");
    w(join(u, ".mozilla/firefox/abc.default/places.sqlite"), "SYNTHETIC-FF-linux-" + h);
    w(join(u, ".mozilla/firefox/abc.default/key4.db"), "MUST-NEVER-BE-COLLECTED");
    w(join(u, ".xsession-errors"), "synthetic xsession");
  }
  return root;
}
