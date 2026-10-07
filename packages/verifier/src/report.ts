// Investigation summary exports. HTML is fully escaped, has a restrictive CSP, no scripts, and never
// turns untrusted paths into links. Collected content is never rendered — only metadata strings.
import type { VerifyReport } from "./verify.js";

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]!));
}

export function summaryJson(r: VerifyReport, meta: { toolVersion: string; planSummary?: unknown }): string {
  return JSON.stringify({ reportSchemaVersion: 1, toolVersion: meta.toolVersion, plan: meta.planSummary ?? null, ...r }, null, 2) + "\n";
}

const label = (v: string) => ({ verified: "Integrity verified", failed: "Integrity NOT verified", unsupported: "Unsupported schema", complete: "Collection complete", partial: "Collection PARTIAL", incomplete: "Collection INCOMPLETE", unknown: "Completeness unknown" }[v] ?? v);

export function renderHtmlReport(r: VerifyReport, meta: { toolVersion: string; generatedUtc: string }): string {
  const badge = (v: string, good: string[]) => `<span class="badge ${good.includes(v) ? "ok" : v === "partial" ? "warn" : "bad"}">${esc(label(v))}</span>`;
  const rows = (cells: string[][]) => cells.map((c) => `<tr>${c.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Collection report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#faf8f5;color:#1f2330;max-width:1100px;margin:2rem auto;padding:0 1rem}
h1,h2{font-weight:600}table{border-collapse:collapse;width:100%;font-size:13px;margin:.5rem 0 1.5rem}th,td{border:1px solid #ddd6cc;padding:4px 8px;text-align:left;vertical-align:top;word-break:break-all}
th{background:#efe9df}.badge{padding:2px 8px;border-radius:10px;font-weight:600}.ok{background:#d6efe4;color:#0b5b3c}.warn{background:#fbecc5;color:#6b4a00}.bad{background:#f8d7d5;color:#8a1c14}
.note{background:#efe9df;padding:.75rem 1rem;border-radius:6px}</style></head><body>
<h1>Endpoint collection report</h1>
<p>${badge(r.integrity, ["verified"])} ${badge(r.completeness, ["complete"])}</p>
<p class="note">${esc(r.disclaimer)}</p>
${r.run ? `<h2>Run</h2><table>${rows([["Run ID", r.run.runId], ["Plan ID", r.run.planId], ["Target OS", r.run.targetOs], ["Host", r.run.host], ["Identity", r.run.identity], ["Elevated", String(r.run.elevated)], ["Started (UTC)", r.run.startedUtc], ["Finished (UTC)", r.run.finishedUtc ?? ""], ["Finalization state", r.run.finalizationState], ["Catalog / generator", `${r.run.catalogVersion} / ${r.run.generatorVersion}`]])}</table>` : ""}
<h2>Findings</h2>${r.findings.length ? `<table><tr><th>Severity</th><th>Code</th><th>Message</th></tr>${rows(r.findings.map((f) => [f.severity, f.code, f.message]))}</table>` : "<p>No findings.</p>"}
<h2>Archive parts</h2><table><tr><th>Part</th><th>Bytes</th><th>Expected</th><th>Hash</th><th>Members</th></tr>${rows(r.parts.map((p) => [p.name, String(p.bytes), String(p.expectedBytes), p.hashStatus, String(p.members)]))}</table>
<h2>Coverage</h2><table><tr><th>Artifact</th><th>Collected</th><th>Partial</th><th>Failed</th><th>Skipped</th><th>Profiles</th></tr>${rows(r.coverage.map((c) => [c.artifactId, String(c.collected), String(c.partial), String(c.failed), String(c.skipped), c.profiles.join(", ")]))}</table>
<h2>Entries (${r.entries.length})</h2><table><tr><th>Artifact</th><th>Profile</th><th>Source</th><th>Outcome</th><th>Bytes</th><th>Hash</th><th>Detail</th></tr>${rows(r.entries.map((e) => [e.artifactId, e.profile, e.source, e.outcome, String(e.bytes), e.hashStatus, [e.error, e.skipReason, e.note].filter(Boolean).join(" | ")]))}</table>
<p>Generated ${esc(meta.generatedUtc)} by Endpoint Evidence Collector ${esc(meta.toolVersion)}. Paths are shown as text only; collected files are never opened or rendered.</p>
</body></html>`;
}
