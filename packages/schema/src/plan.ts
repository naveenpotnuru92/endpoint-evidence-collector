import { z } from "zod";
import {
  OS_LIST, PRESETS, EXECUTION_MODES, USER_SCOPE_MODES, SENSITIVE_SELECTIONS, SCHEMA_VERSION, type TargetOs,
} from "./constants.js";
import { checkLiteralPath, checkOutputRoot, overlapsOutput } from "./paths.js";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLAN_ID = /^plan-[0-9a-f]{12}$/;
const USERNAME = /^[^\u0000-\u001f\u007f\\/:*?"<>|]{1,64}$/u;
const TZ = /^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const UserScopeSchema = z.strictObject({
  mode: z.enum(USER_SCOPE_MODES),
  names: z.array(z.string().regex(USERNAME, "Invalid account name")).max(64),
});

export const TimeWindowSchema = z.strictObject({
  mode: z.enum(["last-days", "range", "none"]),
  days: int(1, 3650).nullable(),
  startUtc: z.string().regex(ISO_UTC).nullable(),
  endUtc: z.string().regex(ISO_UTC).nullable(),
  displayTimezone: z.string().regex(TZ),
});

export const SizeLimitsSchema = z.strictObject({
  perFileBytes: int(1024, 50 * 1024 ** 3),
  totalBytes: int(1024 * 1024, 500 * 1024 ** 3),
  archivePartBytes: int(1024 * 1024, 10 * 1024 ** 3),
  freeSpaceReserveBytes: int(0, 500 * 1024 ** 3),
  maxArchiveParts: int(1, 1000),
});

export const PlanSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  catalogVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  generatorVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  planId: z.string().regex(PLAN_ID),
  caseLabel: z.string().max(80).regex(/^[^\u0000-\u001f\u007f]*$/u).optional(),
  createdAtUtc: z.string().regex(ISO_UTC),
  targetOs: z.enum(OS_LIST),
  preset: z.enum(PRESETS),
  artifactIds: z.array(z.string().regex(SAFE_ID)).max(200),
  userScope: UserScopeSchema,
  includeSystemProfiles: z.boolean(),
  timeWindow: TimeWindowSchema,
  outputRoot: z.string().min(1).max(1024),
  sizeLimits: SizeLimitsSchema,
  runtimeBudgetSeconds: int(30, 24 * 3600),
  customPaths: z.array(z.string().min(1).max(1024)).max(50),
  sensitiveSelections: z.array(z.enum(SENSITIVE_SELECTIONS)).max(10),
  executionMode: z.enum(EXECUTION_MODES),
}).superRefine((p, ctx) => {
  const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const os = p.targetOs as TargetOs;

  if (new Set(p.artifactIds).size !== p.artifactIds.length) add(["artifactIds"], "Duplicate artifact IDs.");
  if (new Set(p.sensitiveSelections).size !== p.sensitiveSelections.length) add(["sensitiveSelections"], "Duplicate sensitive selections.");

  // user scope: names only with named mode
  if (p.userScope.mode === "named" && p.userScope.names.length === 0) add(["userScope", "names"], "Named scope requires at least one account name.");
  if (p.userScope.mode !== "named" && p.userScope.names.length > 0) add(["userScope", "names"], "Account names are only allowed with 'named' scope.");
  if (p.userScope.mode === "named" && new Set(p.userScope.names.map((n) => n.toLowerCase())).size !== p.userScope.names.length) add(["userScope", "names"], "Duplicate account names.");

  // time window consistency
  const tw = p.timeWindow;
  if (tw.mode === "last-days") {
    if (tw.days === null) add(["timeWindow", "days"], "Specify the number of days.");
    if (tw.startUtc !== null || tw.endUtc !== null) add(["timeWindow", "mode"], "Range fields must be empty in 'last-days' mode.");
  } else if (tw.mode === "range") {
    if (tw.startUtc === null || tw.endUtc === null) add(["timeWindow", "startUtc"], "Range mode requires both start and end (UTC).");
    else {
      const s = Date.parse(tw.startUtc), e = Date.parse(tw.endUtc);
      if (Number.isNaN(s) || Number.isNaN(e)) add(["timeWindow", "startUtc"], "Unparseable timestamp.");
      else if (s >= e) add(["timeWindow", "endUtc"], "End must be after start (inverted range).");
    }
    if (tw.days !== null) add(["timeWindow", "days"], "Days must be empty in 'range' mode.");
  } else if (tw.days !== null || tw.startUtc !== null || tw.endUtc !== null) {
    add(["timeWindow", "mode"], "Time fields must be empty when no time window is selected.");
  }

  // limits
  const l = p.sizeLimits;
  if (l.perFileBytes > l.totalBytes) add(["sizeLimits", "perFileBytes"], "Per-file limit cannot exceed the total limit.");
  if (l.archivePartBytes > l.totalBytes && l.totalBytes >= 1024 * 1024) add(["sizeLimits", "archivePartBytes"], "Archive part size larger than the total limit is pointless; lower it.");

  // paths
  const rootIssue = checkOutputRoot(p.outputRoot, os);
  if (rootIssue) add(["outputRoot"], rootIssue);
  p.customPaths.forEach((cp, i) => {
    const issue = checkLiteralPath(cp, os);
    if (issue) return add(["customPaths", i], issue);
    if (!rootIssue && overlapsOutput(cp, p.outputRoot, os)) add(["customPaths", i], "Custom path overlaps the output root (would collect the collector's own output).");
  });
  if (new Set(p.customPaths).size !== p.customPaths.length) add(["customPaths"], "Duplicate custom paths.");

  if (p.preset !== "targeted" && p.artifactIds.length === 0) add(["artifactIds"], "Preset selection resolved to no artifacts.");
  if (p.artifactIds.length === 0 && p.customPaths.length === 0) add(["artifactIds"], "Select at least one artifact or custom path.");
});

export type Plan = z.infer<typeof PlanSchema>;

export interface ValidationIssue { path: string; message: string }
export type ValidationResult = { ok: true; plan: Plan } | { ok: false; issues: ValidationIssue[] };

export function validatePlan(input: unknown): ValidationResult {
  const r = PlanSchema.safeParse(input);
  if (r.success) return { ok: true, plan: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}
