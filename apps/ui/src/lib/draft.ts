// Form draft ⇄ Plan mapping. The draft holds raw operator input (strings); toPlan() converts it into a typed plan
// which is then validated by the shared schema. No endpoint facts are invented here.
import { DEFAULT_LIMITS, DEFAULT_RUNTIME_SECONDS, DEFAULT_TIME_DAYS, GENERATOR_VERSION, MIB, GIB, newPlanId, validatePlan, type Plan, type TargetOs, type ValidationIssue, type Preset } from "@eec/schema";
import { CATALOG_VERSION, getArtifact, presetIds, resolveSelection, sensitiveSelectionsFor } from "@eec/catalog";
import { zonedToUtcIso } from "./time";

export interface Draft {
  planId: string; createdAtUtc: string; caseLabel: string; os: TargetOs | null; preset: Preset;
  artifactIds: string[]; userMode: "all-normal" | "named" | "interactive"; namesText: string; includeSystem: boolean;
  timeMode: "last-days" | "range" | "none"; days: string; startLocal: string; endLocal: string; tz: string;
  outputRoot: string; perFileMiB: string; totalGiB: string; partMiB: string; reserveMiB: string; maxParts: string; runtimeMin: string;
  customPathsText: string; executionMode: "foreground" | "background";
}

export const DEFAULT_OUTPUT: Record<TargetOs, string> = { windows: "C:\\IR\\Evidence", macos: "/var/tmp/eec-evidence", linux: "/var/tmp/eec-evidence" };

export function newDraft(): Draft {
  return { planId: newPlanId(), createdAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), caseLabel: "", os: null, preset: "targeted", artifactIds: [], userMode: "all-normal", namesText: "",
    includeSystem: false, timeMode: "last-days", days: String(DEFAULT_TIME_DAYS), startLocal: "", endLocal: "", tz: "UTC", outputRoot: "",
    perFileMiB: String(DEFAULT_LIMITS.perFileBytes / MIB), totalGiB: String(DEFAULT_LIMITS.totalBytes / GIB), partMiB: String(DEFAULT_LIMITS.archivePartBytes / MIB),
    reserveMiB: String(DEFAULT_LIMITS.freeSpaceReserveBytes / MIB), maxParts: String(DEFAULT_LIMITS.maxArchiveParts), runtimeMin: String(DEFAULT_RUNTIME_SECONDS / 60), customPathsText: "", executionMode: "foreground" };
}

const lines = (t: string) => t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const num = (s: string, mult = 1) => { const n = Number(s); return s.trim() !== "" && Number.isFinite(n) ? Math.round(n * mult) : NaN; };

/** Field-level problems that exist before schema validation (unparseable numbers/dates). Keyed by form field id. */
export function draftIssues(d: Draft): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (!d.os) out.push({ path: "os", message: "Choose a target operating system." });
  const chk = (id: string, v: string, label: string) => { if (!Number.isFinite(Number(v)) || v.trim() === "") out.push({ path: id, message: `${label} must be a number.` }); };
  chk("perFileMiB", d.perFileMiB, "Per-file limit"); chk("totalGiB", d.totalGiB, "Total limit"); chk("partMiB", d.partMiB, "Archive part size"); chk("reserveMiB", d.reserveMiB, "Free-space reserve"); chk("maxParts", d.maxParts, "Max archive parts"); chk("runtimeMin", d.runtimeMin, "Runtime budget");
  if (d.timeMode === "last-days") chk("days", d.days, "Number of days");
  if (d.timeMode === "range") {
    if (!zonedToUtcIso(d.startLocal, d.tz)) out.push({ path: "startLocal", message: "Enter a valid start date and time." });
    if (!zonedToUtcIso(d.endLocal, d.tz)) out.push({ path: "endLocal", message: "Enter a valid end date and time." });
  }
  return out;
}

export function toPlan(d: Draft): Plan | Record<string, unknown> {
  const os = d.os ?? "linux";
  const ids = resolveSelection(d.artifactIds, os).ids.length ? d.artifactIds : d.artifactIds;
  const names = d.userMode === "named" ? lines(d.namesText) : [];
  return {
    schemaVersion: 1, catalogVersion: CATALOG_VERSION, generatorVersion: GENERATOR_VERSION, planId: d.planId, ...(d.caseLabel.trim() ? { caseLabel: d.caseLabel.trim() } : {}),
    createdAtUtc: d.createdAtUtc, targetOs: os, preset: d.preset, artifactIds: ids, userScope: { mode: d.userMode, names }, includeSystemProfiles: d.includeSystem,
    timeWindow: d.timeMode === "last-days" ? { mode: "last-days", days: num(d.days), startUtc: null, endUtc: null, displayTimezone: d.tz }
      : d.timeMode === "range" ? { mode: "range", days: null, startUtc: zonedToUtcIso(d.startLocal, d.tz), endUtc: zonedToUtcIso(d.endLocal, d.tz), displayTimezone: d.tz }
      : { mode: "none", days: null, startUtc: null, endUtc: null, displayTimezone: d.tz },
    outputRoot: d.outputRoot.trim(), sizeLimits: { perFileBytes: num(d.perFileMiB, MIB), totalBytes: num(d.totalGiB, GIB), archivePartBytes: num(d.partMiB, MIB), freeSpaceReserveBytes: num(d.reserveMiB, MIB), maxArchiveParts: num(d.maxParts) },
    runtimeBudgetSeconds: num(d.runtimeMin, 60), customPaths: lines(d.customPathsText), sensitiveSelections: sensitiveSelectionsFor(ids), executionMode: d.executionMode,
  };
}

/** Map a schema issue path to the form field id that owns it (for "fix" links). */
const FORM_FIELD_STEP: Record<string, number> = { os: 0, perFileMiB: 2, totalGiB: 2, partMiB: 2, reserveMiB: 2, maxParts: 2, runtimeMin: 2, days: 2, startLocal: 2, endLocal: 2 };
export function fieldForPath(path: string): { field: string; step: number } {
  if (path in FORM_FIELD_STEP) return { field: path, step: FORM_FIELD_STEP[path]! };   // issue already keyed by a form field id
  const p = path.split(".");
  switch (p[0]) {
    case "targetOs": return { field: "os", step: 0 }; case "outputRoot": return { field: "outputRoot", step: 2 }; case "customPaths": return { field: "customPathsText", step: 2 };
    case "artifactIds": case "sensitiveSelections": return { field: "artifact-search", step: 1 };
    case "userScope": return { field: p[1] === "names" ? "namesText" : "userMode", step: 2 };
    case "timeWindow": return { field: p[1] === "days" ? "days" : p[1] === "startUtc" ? "startLocal" : p[1] === "endUtc" ? "endLocal" : "timeMode", step: 2 };
    case "sizeLimits": return { field: ({ perFileBytes: "perFileMiB", totalBytes: "totalGiB", archivePartBytes: "partMiB", freeSpaceReserveBytes: "reserveMiB", maxArchiveParts: "maxParts" } as Record<string, string>)[p[1] ?? ""] ?? "perFileMiB", step: 2 };
    case "runtimeBudgetSeconds": return { field: "runtimeMin", step: 2 };
    case "executionMode": return { field: "executionMode", step: 2 };
    default: return { field: "caseLabel", step: 0 };
  }
}

export function validateDraft(d: Draft): { plan: Plan | null; issues: ValidationIssue[] } {
  const pre = draftIssues(d);
  if (!d.os) return { plan: null, issues: pre };
  // Unparseable numbers are already reported above; substitute defaults so the schema can still report every OTHER problem in one pass.
  const raw = toPlan(d) as Record<string, any>;
  const dflt = { perFileBytes: DEFAULT_LIMITS.perFileBytes, totalBytes: DEFAULT_LIMITS.totalBytes, archivePartBytes: DEFAULT_LIMITS.archivePartBytes, freeSpaceReserveBytes: DEFAULT_LIMITS.freeSpaceReserveBytes, maxArchiveParts: DEFAULT_LIMITS.maxArchiveParts } as Record<string, number>;
  for (const k of Object.keys(dflt)) if (Number.isNaN(raw.sizeLimits[k])) raw.sizeLimits[k] = dflt[k];
  if (Number.isNaN(raw.runtimeBudgetSeconds)) raw.runtimeBudgetSeconds = DEFAULT_RUNTIME_SECONDS;
  if (raw.timeWindow.mode === "last-days" && Number.isNaN(raw.timeWindow.days)) raw.timeWindow.days = DEFAULT_TIME_DAYS;
  const v = validatePlan(raw);
  const mapped: ValidationIssue[] = v.ok ? [] : v.issues;
  // Drop schema noise caused only by an unparseable number (already reported in a friendlier way).
  const issues = [...pre, ...mapped];
  return { plan: v.ok && pre.length === 0 ? v.plan : null, issues };
}

export interface PresetDiff { add: string[]; remove: string[] }
/** Preview of what choosing a preset would change (so custom selections are never replaced silently). */
export function presetDiff(d: Draft, preset: Preset): PresetDiff {
  if (!d.os || preset === "targeted") return { add: [], remove: [] };
  const target = new Set(presetIds(preset, d.os)); const cur = new Set(d.artifactIds);
  return { add: [...target].filter((x) => !cur.has(x)), remove: [...cur].filter((x) => !target.has(x)) };
}
export const artifactName = (id: string) => getArtifact(id)?.name ?? id;

import { utcIsoToZonedLocal } from "./time";
/** Saved plan → editable draft (inverse of toPlan). */
export function planToDraft(p: Plan): Draft {
  const sl = p.sizeLimits;
  return { planId: p.planId, createdAtUtc: p.createdAtUtc, caseLabel: p.caseLabel ?? "", os: p.targetOs, preset: p.preset, artifactIds: [...p.artifactIds], userMode: p.userScope.mode, namesText: p.userScope.names.join("\n"),
    includeSystem: p.includeSystemProfiles, timeMode: p.timeWindow.mode, days: String(p.timeWindow.days ?? DEFAULT_TIME_DAYS), tz: p.timeWindow.displayTimezone,
    startLocal: utcIsoToZonedLocal(p.timeWindow.startUtc, p.timeWindow.displayTimezone), endLocal: utcIsoToZonedLocal(p.timeWindow.endUtc, p.timeWindow.displayTimezone),
    outputRoot: p.outputRoot, perFileMiB: String(sl.perFileBytes / MIB), totalGiB: String(sl.totalBytes / GIB), partMiB: String(sl.archivePartBytes / MIB), reserveMiB: String(sl.freeSpaceReserveBytes / MIB),
    maxParts: String(sl.maxArchiveParts), runtimeMin: String(p.runtimeBudgetSeconds / 60), customPathsText: p.customPaths.join("\n"), executionMode: p.executionMode };
}
