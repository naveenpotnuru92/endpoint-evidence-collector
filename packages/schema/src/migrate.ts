// Versioned migrations for SAVED plans. Each step upgrades exactly one schemaVersion.
// Newer-than-known versions are rejected (never guessed at).
import { SCHEMA_VERSION } from "./constants.js";

export interface SavedPlan { savedFormat: 1; savedAtUtc: string; plan: unknown }

const steps: Record<number, (p: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 -> 1 example: pre-release plans had no 'executionMode'. Kept to exercise the migration path in tests.
  0: (p) => ({ ...p, schemaVersion: 1, executionMode: p.executionMode ?? "foreground" }),
};

export function migratePlan(raw: unknown): { plan: unknown; migratedFrom: number | null } {
  if (!raw || typeof raw !== "object") throw new Error("Saved plan is not an object.");
  let p = raw as Record<string, unknown>;
  const from = typeof p.schemaVersion === "number" ? p.schemaVersion : 0;
  if (from > SCHEMA_VERSION) throw new Error(`Plan schemaVersion ${from} is newer than this build supports (${SCHEMA_VERSION}).`);
  let v = from;
  while (v < SCHEMA_VERSION) { const s = steps[v]; if (!s) throw new Error(`No migration from schemaVersion ${v}.`); p = s(p); v = typeof p.schemaVersion === "number" ? p.schemaVersion : v + 1; }
  return { plan: p, migratedFrom: from === SCHEMA_VERSION ? null : from };
}
