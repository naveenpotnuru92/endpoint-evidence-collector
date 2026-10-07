export const SCHEMA_VERSION = 1 as const;
export const GENERATOR_VERSION = "0.1.0";

export const OS_LIST = ["windows", "macos", "linux"] as const;
export type TargetOs = (typeof OS_LIST)[number];

export const PRESETS = ["quick-triage", "investigation", "targeted"] as const;
export type Preset = (typeof PRESETS)[number];

export const EXECUTION_MODES = ["foreground", "background"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const SENSITIVITY = ["low", "moderate", "personal-data", "sensitive-option"] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];

export const IMPL_STATUS = ["planned", "implemented-unverified", "verified"] as const;
export type ImplStatus = (typeof IMPL_STATUS)[number];

export const PRIVILEGE = ["none", "elevated-recommended", "elevated-required"] as const;
export type Privilege = (typeof PRIVILEGE)[number];

export const ACQUISITION = ["copy", "export", "snapshot", "command-output", "metadata"] as const;
export type Acquisition = (typeof ACQUISITION)[number];

export const TIME_FILTER = ["native", "post-filter", "none"] as const;
export type TimeFilter = (typeof TIME_FILTER)[number];

export const USER_SCOPE_MODES = ["all-normal", "named", "interactive"] as const;
export type UserScopeMode = (typeof USER_SCOPE_MODES)[number];

/** Sensitive options that can be explicitly selected. Credential / session stores are NOT in this list on purpose. */
export const SENSITIVE_SELECTIONS = ["process-command-lines"] as const;
export type SensitiveSelection = (typeof SENSITIVE_SELECTIONS)[number];

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

export const DEFAULT_LIMITS = {
  perFileBytes: 250 * MIB,
  totalBytes: 2 * GIB,
  archivePartBytes: 250 * MIB,
  freeSpaceReserveBytes: 512 * MIB,
  maxArchiveParts: 64,
} as const;
export const DEFAULT_RUNTIME_SECONDS = 15 * 60;
export const DEFAULT_TIME_DAYS = 7;
