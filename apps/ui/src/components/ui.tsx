import type { ReactNode } from "react";
import type { ArtifactDef, ImplStatus } from "@eec/schema";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) { return <span className={`badge b-${tone}`} title={title}>{children}</span>; }
export function Notice({ tone, title, children }: { tone: "warn" | "bad" | "info" | "ok"; title?: string; children?: ReactNode }) {
  return <div className={`notice n-${tone}`} role={tone === "bad" ? "alert" : "status"}>{title && <strong>{title}</strong>}{title && children ? " — " : ""}{children}</div>;
}
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return <div className="field"><label className="lbl" htmlFor={id} style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{label}</label>{children}{hint && <div className="hint" id={`${id}-hint`}>{hint}</div>}{error && <div className="err" id={`${id}-err`}>{error}</div>}</div>;
}

export const statusLabel: Record<ImplStatus, string> = { planned: "Planned — no collector", "implemented-unverified": "Implemented, unverified", verified: "Verified" };
export const statusTone: Record<ImplStatus, Tone> = { planned: "bad", "implemented-unverified": "warn", verified: "ok" };
export const sensLabel: Record<ArtifactDef["sensitivity"], string> = { low: "Low sensitivity", moderate: "Moderate sensitivity", "personal-data": "Personal data", "sensitive-option": "Sensitive option" };
export const sensTone: Record<ArtifactDef["sensitivity"], Tone> = { low: "neutral", moderate: "info", "personal-data": "warn", "sensitive-option": "bad" };
export const privLabel: Record<ArtifactDef["privilege"], string> = { none: "Ordinary privileges", "elevated-recommended": "Elevation recommended", "elevated-required": "Elevation required" };
export const timeLabel: Record<ArtifactDef["timeFilter"], string> = { native: "Time filter: native", "post-filter": "Time filter: partial", none: "No time filter" };

export function fmtBytes(n: number): string { if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2).replace(/\.00$/, "") + " GiB"; if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1).replace(/\.0$/, "") + " MiB"; if (n >= 1024) return (n / 1024).toFixed(1) + " KiB"; return n + " B"; }
export const osName = { windows: "Windows", macos: "macOS", linux: "Linux" } as const;
