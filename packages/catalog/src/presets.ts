import type { PresetDef } from "@eec/schema";

// Presets list artifact IDs only. Sensitive-option artifacts (e.g. command lines) never appear here.
export const PRESETS_DEF: PresetDef[] = [
  { id: "quick-triage", name: "Quick triage", description: "Baseline, bounded volatile snapshot, recent system/security logs, scheduled execution, startup/persistence. No browser data.",
    note: "Contains collectors that are implemented but not yet verified on target OS builds.",
    artifactIdsByOs: {
      windows: ["win.baseline.system", "win.volatile.processes", "win.volatile.network", "win.logs.security", "win.logs.system", "win.scheduled.tasks", "win.persistence.services", "win.persistence.startup"],
      macos: ["mac.baseline.system", "mac.volatile.processes", "mac.volatile.network", "mac.logs.system", "mac.scheduled.cron", "mac.scheduled.launchd", "mac.persistence.launchd"],
      linux: ["lin.baseline.system", "lin.volatile.processes", "lin.volatile.network", "lin.logs.auth", "lin.logs.syslog", "lin.scheduled.cron", "lin.scheduled.timers", "lin.persistence.services"],
    } },
  { id: "investigation", name: "Investigation", description: "Quick triage plus browser history/configuration and user logs across discovered profiles. Includes personal data.",
    note: "Browser history and downloads are personal data; the review screen flags them.",
    artifactIdsByOs: {
      windows: ["win.baseline.system", "win.volatile.processes", "win.volatile.network", "win.logs.security", "win.logs.system", "win.logs.application", "win.scheduled.tasks", "win.persistence.services", "win.persistence.startup", "win.registry.autoruns",
        "win.browser.chromium.history", "win.browser.chromium.config", "win.browser.firefox.history", "win.browser.firefox.config"],
      macos: ["mac.baseline.system", "mac.volatile.processes", "mac.volatile.network", "mac.logs.system", "mac.scheduled.cron", "mac.scheduled.launchd", "mac.persistence.launchd",
        "mac.browser.chromium.history", "mac.browser.chromium.config", "mac.browser.firefox.history", "mac.browser.firefox.config", "mac.userlogs.user"],
      linux: ["lin.baseline.system", "lin.volatile.processes", "lin.volatile.network", "lin.logs.auth", "lin.logs.syslog", "lin.scheduled.cron", "lin.scheduled.timers", "lin.persistence.services",
        "lin.browser.chromium.history", "lin.browser.firefox.history", "lin.userlogs.user"],
    } },
  { id: "targeted", name: "Targeted", description: "Only the categories you select.", note: "", artifactIdsByOs: { windows: [], macos: [], linux: [] } },
];
