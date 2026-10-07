// Settings live in React state; they are written to localStorage ONLY when the operator presses "Save settings".
// No plan content, personal data, or secrets are ever stored here. "Clear" removes the key.
export interface TransportProfile {
  name: string; timeoutMinutes: number | null; partLimitMiB: number | null; interpreters: string; signingPolicy: "unknown" | "none-required" | "required";
  workingDirectory: "unknown" | "script-directory" | "fixed-by-edr"; background: "unknown" | "validated-supported" | "not-supported";
}
export interface Settings { theme: "system" | "light" | "dark"; defaultPerFileMiB: number; defaultTotalGiB: number; transport: TransportProfile }
export const DEFAULT_TRANSPORT: TransportProfile = { name: "Internal EDR — unvalidated", timeoutMinutes: null, partLimitMiB: null, interpreters: "", signingPolicy: "unknown", workingDirectory: "unknown", background: "unknown" };
export const DEFAULT_SETTINGS: Settings = { theme: "system", defaultPerFileMiB: 250, defaultTotalGiB: 2, transport: DEFAULT_TRANSPORT };
export const STORAGE_KEY = "eec.settings.v1";

export function loadSettings(): Settings {
  try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return DEFAULT_SETTINGS; const p = JSON.parse(raw); return { ...DEFAULT_SETTINGS, ...p, transport: { ...DEFAULT_TRANSPORT, ...(p.transport ?? {}) } }; } catch { return DEFAULT_SETTINGS; }
}
export const saveSettings = (s: Settings) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
export const clearSettings = () => localStorage.removeItem(STORAGE_KEY);
export const hasSavedSettings = () => localStorage.getItem(STORAGE_KEY) !== null;
