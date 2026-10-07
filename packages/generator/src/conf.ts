// Builds collector.conf: TAB-separated "key<TAB>value" lines. The Unix collector reads it as DATA
// (read -r), never sourcing or evaluating it. Values containing TAB/CR/LF/NUL are rejected outright.
import type { Plan } from "@eec/schema";

function clean(v: string, key: string): string {
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`Refusing to emit control characters in config value for '${key}'`);
  return v;
}

export function buildConf(plan: Plan, planFileSha256: string): string {
  const lines: [string, string | number][] = [
    ["schema", 1], ["plan_id", plan.planId], ["plan_digest", planFileSha256], ["catalog_version", plan.catalogVersion],
    ["generator_version", plan.generatorVersion], ["target_os", plan.targetOs], ["output_root", plan.outputRoot],
    ["user_scope", plan.userScope.mode], ["include_system_profiles", plan.includeSystemProfiles ? 1 : 0],
    ["time_mode", plan.timeWindow.mode], ["time_days", plan.timeWindow.days ?? ""],
    ["time_start", plan.timeWindow.startUtc ?? ""], ["time_end", plan.timeWindow.endUtc ?? ""],
    ["per_file_bytes", plan.sizeLimits.perFileBytes], ["total_bytes", plan.sizeLimits.totalBytes],
    ["archive_part_bytes", plan.sizeLimits.archivePartBytes], ["free_space_reserve_bytes", plan.sizeLimits.freeSpaceReserveBytes],
    ["max_archive_parts", plan.sizeLimits.maxArchiveParts], ["runtime_seconds", plan.runtimeBudgetSeconds],
    ["execution_mode", plan.executionMode],
  ];
  for (const n of plan.userScope.names) lines.push(["user_name", n]);
  for (const a of plan.artifactIds) lines.push(["artifact", a]);
  for (const c of plan.customPaths) lines.push(["custom_path", c]);
  for (const s of plan.sensitiveSelections) lines.push(["sensitive", s]);
  return lines.map(([k, v]) => `${k}\t${clean(String(v), k)}`).join("\n") + "\n";
}
