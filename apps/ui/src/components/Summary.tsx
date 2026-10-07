import type { Plan, ValidationIssue } from "@eec/schema";
import { getArtifact } from "@eec/catalog";
import type { Draft } from "../lib/draft";
import { Badge, osName, fmtBytes } from "./ui";

/** Persistent review panel. Everything here is plan data — never endpoint results. */
export function Summary({ draft, plan, issues, dirty, stale }: { draft: Draft; plan: Plan | null; issues: ValidationIssue[]; dirty: boolean; stale: boolean }) {
  const arts = draft.artifactIds.map((i) => getArtifact(i)).filter(Boolean) as NonNullable<ReturnType<typeof getArtifact>>[];
  const sens = arts.filter((a) => a.sensitivity === "personal-data" || a.sensitivity === "sensitive-option");
  const elevated = arts.filter((a) => a.privilege === "elevated-required").length, recommended = arts.filter((a) => a.privilege === "elevated-recommended").length;
  const unverified = arts.filter((a) => (a.status[draft.os!] ?? "planned") !== "verified").length;
  const groups = new Set(arts.map((a) => a.category)).size;
  const tw = draft.timeMode === "none" ? "No time window" : draft.timeMode === "last-days" ? `Last ${draft.days || "?"} day(s) (relative to run time)` : plan ? `${plan.timeWindow.startUtc} → ${plan.timeWindow.endUtc} UTC` : "Range incomplete";
  return (
    <aside className="summary" aria-label="Collection summary" tabIndex={0}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><h2 style={{ margin: 0 }}>Collection summary</h2></div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
        <Badge tone="warn">Planning preview</Badge><Badge tone="neutral">Not collected</Badge>
        {dirty && <Badge tone="warn">Unsaved edits</Badge>}{stale && <Badge tone="bad">Export out of date</Badge>}
        {issues.length === 0 && plan ? <Badge tone="ok">Plan valid</Badge> : <Badge tone="bad">{issues.length} issue{issues.length === 1 ? "" : "s"} to resolve</Badge>}
      </div>
      <p className="muted small">This is what will be requested, not what exists on any endpoint. No endpoint has been contacted.</p>
      <dl>
        <dt>Target</dt><dd>{draft.os ? osName[draft.os] : "Not chosen"} · preset: {draft.preset}</dd>
        <dt>Selected</dt><dd>{arts.length} artifact{arts.length === 1 ? "" : "s"} in {groups} group{groups === 1 ? "" : "s"}{draft.customPathsText.trim() ? ` + ${draft.customPathsText.trim().split(/\n/).length} custom path(s)` : ""}</dd>
        <dt>User scope</dt><dd>{draft.userMode === "all-normal" ? "All normal local profiles (discovered on the endpoint)" : draft.userMode === "named" ? `Named accounts: ${draft.namesText.trim().split(/\n/).filter(Boolean).length}` : "Endpoint-detected interactive user (must be exactly one)"}{draft.includeSystem ? " · system/service profiles included" : ""}</dd>
        <dt>Time window</dt><dd>{tw}<div className="muted small">Applies only to artifacts with native time filtering.</div></dd>
        <dt>Sensitivity</dt><dd>{sens.length === 0 ? "No personal-data or sensitive-option artifacts" : sens.map((a) => <div key={a.id}><Badge tone={a.sensitivity === "personal-data" ? "warn" : "bad"}>{a.sensitivity === "personal-data" ? "Personal data" : "Sensitive option"}</Badge> {a.name}</div>)}</dd>
        <dt>Privilege</dt><dd>{elevated} need elevation · {recommended} better with elevation<div className="muted small">The collector never elevates itself.</div></dd>
        <dt>Support</dt><dd>{unverified > 0 ? <Badge tone="warn">{unverified} collector(s) unverified on targets</Badge> : arts.length ? <Badge tone="ok">All verified</Badge> : "—"}</dd>
        <dt>Limits</dt><dd>{plan ? `${fmtBytes(plan.sizeLimits.perFileBytes)}/file · ${fmtBytes(plan.sizeLimits.totalBytes)} total · ${plan.runtimeBudgetSeconds / 60} min` : "Incomplete"}<div className="muted small">Size and runtime are unknown until an endpoint is measured.</div></dd>
        <dt>Execution</dt><dd>{draft.executionMode}</dd>
        <dt>Collection status</dt><dd>Not started — this app never runs anything on an endpoint.</dd>
      </dl>
    </aside>
  );
}
