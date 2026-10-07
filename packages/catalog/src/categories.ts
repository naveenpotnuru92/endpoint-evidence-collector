import type { CategoryDef } from "@eec/schema";

// Categories group artifacts in the UI. Aliases drive keyword search.
export const CATEGORIES: CategoryDef[] = [
  { id: "baseline", name: "System baseline", os: ["windows", "macos", "linux"], aliases: ["system", "baseline", "host", "info", "os version", "hardware", "uptime"],
    description: "OS version, hostname, uptime, execution identity and installed-software metadata." },
  { id: "volatile", name: "Volatile snapshot", os: ["windows", "macos", "linux"], aliases: ["volatile", "process", "processes", "network", "connections", "netstat", "live", "listening"],
    description: "Bounded point-in-time process list and network state. Collected first and timestamped." },
  { id: "logs", name: "System & security logs", os: ["windows", "macos", "linux"], aliases: ["log", "logs", "event", "evtx", "security log", "auth", "authentication", "journal", "unified", "syslog", "audit"],
    description: "Selected operating-system and security logs exported with bounded size." },
  { id: "scheduled", name: "Scheduled execution", os: ["windows", "macos", "linux"], aliases: ["scheduled", "schedule", "task", "tasks", "cron", "crontab", "timer", "timers", "launchd", "at"],
    description: "Task / cron / timer definitions that cause code to run later. Maps to different mechanisms per OS." },
  { id: "persistence", name: "Services & startup", os: ["windows", "macos", "linux"], aliases: ["startup", "persistence", "autorun", "autostart", "service", "services", "launch agent", "launch daemon", "login item", "systemd", "run key"],
    description: "Service definitions and startup/autostart configuration." },
  { id: "registry", name: "Registry", os: ["windows"], aliases: ["registry", "reg", "hive", "run keys", "hklm", "hkcu"],
    description: "Selected, fixed registry locations. Broad hive export is a separate, optional capability." },
  { id: "browser", name: "Browser artifacts", os: ["windows", "macos", "linux"], aliases: ["browser", "chrome", "edge", "firefox", "safari", "history", "downloads", "extensions", "web", "chromium", "brave"],
    description: "Per-user, per-profile browser activity and configuration. Personal data. Credential/cookie stores are NOT collectable." },
  { id: "userlogs", name: "User & application logs", os: ["windows", "macos", "linux"], aliases: ["application log", "app log", "user log", "diagnostic", "crash", "installer log"],
    description: "Selected existing user/application log files." },
  { id: "custom", name: "Custom files", os: ["windows", "macos", "linux"], aliases: ["custom", "file", "path", "specific file"],
    description: "Explicit literal file paths entered by the operator. No globs, no network paths." },
];
