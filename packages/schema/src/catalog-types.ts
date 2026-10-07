import type { Acquisition, ImplStatus, Privilege, Sensitivity, TargetOs, TimeFilter } from "./constants.js";

export type UserScopeBehavior = "machine-wide" | "per-user" | "per-user-profile";

export interface ArtifactDef {
  id: string;
  name: string;
  aliases: string[];
  category: string;      // category id
  group: string;         // sub-group within category (e.g. browser:history)
  os: TargetOs[];
  versionConstraints: string;
  description: string;
  discovery: string;     // source-discovery method
  userScope: UserScopeBehavior;
  privilege: Privilege;
  sensitivity: Sensitivity;
  acquisition: Acquisition;
  acquisitionDetail: string;
  timeFilter: TimeFilter;
  timeFilterNote: string;
  dependsOn: string[];
  failureModes: string[];
  output: string;        // output naming under run dir
  fixtures: string[];
  sources: string[];     // exact sources (display)
  references: string[];  // documentation to verify against
  status: Partial<Record<TargetOs, ImplStatus>>;
  /** Sub-group is excluded from "select all" in its group */
  selectAllExcluded?: boolean;
}

export interface CategoryDef {
  id: string;
  name: string;
  description: string;
  os: TargetOs[];
  aliases: string[];
}

export interface PresetDef {
  id: "quick-triage" | "investigation" | "targeted";
  name: string;
  description: string;
  artifactIdsByOs: Record<TargetOs, string[]>;
  note: string;
}
