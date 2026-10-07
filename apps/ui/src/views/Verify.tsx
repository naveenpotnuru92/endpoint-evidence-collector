import { useMemo, useRef, useState } from "react";
import { api, fetchText, download } from "../lib/api";
import { Badge, Notice, fmtBytes, type Tone } from "../components/ui";

// Shape mirrors @eec/verifier VerifyReport (kept structural so the UI never imports Node-only code).
interface Report {
  integrity: "verified" | "failed" | "unsupported"; completeness: "complete" | "partial" | "incomplete" | "unknown";
  findings: { severity: "error" | "warning" | "info"; code: string; message: string }[];
  run: { runId: string; planId: string; finalizationState: string; host: string; identity: string; elevated: boolean; startedUtc: string; finishedUtc: string | null; catalogVersion: string; generatorVersion: string; targetOs: string } | null;
  parts: { name: string; bytes: number; expectedBytes: number; hashStatus: string; members: number }[];
  coverage: { artifactId: string; collected: number; partial: number; failed: number; skipped: number; profiles: string[] }[];
  entries: { artifactId: string; profile: string; source: string; destination: string; method: string; outcome: string; bytes: number; hashStatus: string; error: string; skipReason: string; note: string; timeFilterApplied: boolean }[];
  totals: { entries: number; hashMatch: number; hashMismatch: number; missingMember: number; unlistedMembers: number }; disclaimer: string;
}
const intTone: Record<string, Tone> = { verified: "ok", failed: "bad", unsupported: "warn" };
const intLabel: Record<string, string> = { verified: "Integrity verified", failed: "Integrity NOT verified", unsupported: "Unsupported schema" };
const comTone: Record<string, Tone> = { complete: "ok", partial: "warn", incomplete: "bad", unknown: "neutral" };
const comLabel: Record<string, string> = { complete: "Collection complete", partial: "Collection partial", incomplete: "Collection incomplete", unknown: "Completeness unknown" };

export function Verify() {
  const [files, setFiles] = useState<File[]>([]); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null); const [job, setJob] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hasIndex = files.some((f) => f.name === "retrieval-index.json");

  const run = async () => {
    setError(null); setReport(null);
    try {
      if (job) await api(`/api/imports/${job}`, { method: "DELETE" }).catch(() => {});
      const { jobId } = await api<{ jobId: string }>("/api/imports", { method: "POST" }); setJob(jobId);
      for (const f of files) { setBusy(`Importing ${f.name}…`); await api(`/api/imports/${jobId}/files/${encodeURIComponent(f.name)}`, { method: "PUT", body: f }); }
      setBusy("Verifying…"); setReport(await api<Report>(`/api/imports/${jobId}/verify`, { method: "POST", json: {} }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  return (<>
    <h1>Verify retrieved collection</h1>
    <p className="muted" style={{ maxWidth: 760 }}>Select the files you pulled through your EDR: <code>retrieval-index.json</code>, <code>manifest.json</code>, <code>status.json</code> and all <code>part-*</code> archives. Files are copied into a private temporary job folder, hashed and read as data — never extracted to a chosen location, opened or executed.</p>
    <div className="canvas" style={{ marginBottom: 24 }}>
      <input ref={input} id="verify-files" type="file" multiple style={{ display: "none" }} onChange={(e) => { setFiles([...(e.target.files ?? [])]); setReport(null); }} />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" onClick={() => input.current?.click()}>Choose files…</button>
        <button className="btn primary" disabled={!hasIndex || !!busy} onClick={run}>Verify</button>
        {busy && <span role="status">{busy}</span>}
        {job && <button className="btn danger" onClick={async () => { await api(`/api/imports/${job}`, { method: "DELETE" }); setJob(null); setReport(null); setFiles([]); }}>Discard imported copies</button>}
      </div>
      {files.length === 0 ? <div className="empty" style={{ marginTop: 16 }}>No files selected. Choose the retrieval index and every archive part.</div> :
        <><p className="small muted" style={{ marginTop: 12 }}>{files.length} file(s), {fmtBytes(files.reduce((n, f) => n + f.size, 0))}</p>
          {!hasIndex && <Notice tone="warn" title="retrieval-index.json missing">Verification needs the external index.</Notice>}
          <ul className="small">{files.map((f) => <li key={f.name} className="mono">{f.name} <span className="muted">({fmtBytes(f.size)})</span></li>)}</ul></>}
      {error && <Notice tone="bad" title="Verification could not run">{error}</Notice>}
    </div>
    {report && <ReportView report={report} job={job!} />}
  </>);
}

function ReportView({ report: r, job }: { report: Report; job: string }) {
  const [q, setQ] = useState(""); const [outcome, setOutcome] = useState("all");
  const rows = useMemo(() => r.entries.filter((e) => (outcome === "all" || e.outcome === outcome) && (!q || [e.artifactId, e.profile, e.source, e.destination, e.error, e.skipReason].join(" ").toLowerCase().includes(q.toLowerCase()))), [r, q, outcome]);
  const exportReport = async (kind: "json" | "html") => download(`collection-report.${kind}`, await fetchText(`/api/imports/${job}/report.${kind}`), kind === "json" ? "application/json" : "text/html");
  return (<section aria-labelledby="rep-title">
    <h2 id="rep-title">Collection report</h2>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      <Badge tone={intTone[r.integrity]}>{intLabel[r.integrity]}</Badge><Badge tone={comTone[r.completeness]}>{comLabel[r.completeness]}</Badge>
      <button className="btn" onClick={() => exportReport("json")}>Export summary JSON</button><button className="btn" onClick={() => exportReport("html")}>Export HTML report</button>
    </div>
    <Notice tone="info">{r.disclaimer} Integrity and completeness are reported separately: integrity says the bytes match what was recorded; completeness says whether everything requested was collected.</Notice>
    {r.run && <div className="canvas" style={{ marginBottom: 16 }}><h3>Run</h3><dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: 0 }}>
      {([["Run ID", r.run.runId], ["Plan ID", r.run.planId], ["Target OS", r.run.targetOs], ["Host", r.run.host], ["Executed as", `${r.run.identity}${r.run.elevated ? " (elevated)" : " (not elevated)"}`], ["Started", r.run.startedUtc], ["Finished", r.run.finishedUtc ?? "—"], ["Finalization", r.run.finalizationState], ["Catalog / generator", `${r.run.catalogVersion} / ${r.run.generatorVersion}`]] as const).map(([k, v]) => <><dt className="muted">{k}</dt><dd style={{ margin: 0 }} className="mono">{v}</dd></>)}</dl></div>}
    <h3>Findings ({r.findings.length})</h3>
    {r.findings.length === 0 ? <p className="muted small">No findings.</p> : <div className="tablewrap"><table><thead><tr><th>Severity</th><th>Code</th><th>Message</th></tr></thead><tbody>{r.findings.map((f, i) => <tr key={i}><td><Badge tone={f.severity === "error" ? "bad" : f.severity === "warning" ? "warn" : "info"}>{f.severity}</Badge></td><td className="mono">{f.code}</td><td>{f.message}</td></tr>)}</tbody></table></div>}
    <h3 style={{ marginTop: 20 }}>Archive parts</h3>
    <div className="tablewrap"><table><thead><tr><th>Part</th><th>Size</th><th>Expected</th><th>Hash</th></tr></thead><tbody>{r.parts.map((p) => <tr key={p.name}><td className="mono">{p.name}</td><td>{fmtBytes(p.bytes)}</td><td>{fmtBytes(p.expectedBytes)}</td><td><Badge tone={p.hashStatus === "match" ? "ok" : "bad"}>{p.hashStatus}</Badge></td></tr>)}</tbody></table></div>
    <h3 style={{ marginTop: 20 }}>Coverage matrix</h3>
    <div className="tablewrap"><table><thead><tr><th>Artifact</th><th>Collected</th><th>Partial</th><th>Failed</th><th>Skipped</th><th>Users / profiles</th></tr></thead><tbody>{r.coverage.map((c) => <tr key={c.artifactId}><td className="mono">{c.artifactId}</td><td>{c.collected}</td><td>{c.partial || ""}</td><td>{c.failed ? <Badge tone="bad">{c.failed} failed</Badge> : ""}</td><td>{c.skipped || ""}</td><td>{c.profiles.join(", ")}</td></tr>)}</tbody></table></div>
    <h3 style={{ marginTop: 20 }}>Entries ({rows.length} of {r.entries.length})</h3>
    <div style={{ display: "flex", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
      <input type="search" aria-label="Filter entries" placeholder="Filter by artifact, user, path, error…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      <select aria-label="Outcome filter" value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ maxWidth: 200 }}><option value="all">All outcomes</option><option>collected</option><option>partial</option><option>failed</option><option>skipped</option></select>
    </div>
    <p className="small muted">Metadata only — collected file contents are never previewed, opened or executed. Paths are shown as plain text.</p>
    <div className="tablewrap"><table><thead><tr><th>Artifact</th><th>Profile</th><th>Source</th><th>Outcome</th><th>Bytes</th><th>Hash</th><th>Detail</th></tr></thead><tbody>
      {rows.slice(0, 1000).map((e, i) => <tr key={i}><td className="mono">{e.artifactId}</td><td>{e.profile}</td><td className="mono">{e.source}</td><td><Badge tone={e.outcome === "collected" ? "ok" : e.outcome === "skipped" ? "neutral" : e.outcome === "partial" ? "warn" : "bad"}>{e.outcome}</Badge></td><td>{e.bytes}</td>
        <td><Badge tone={e.hashStatus === "match" ? "ok" : e.hashStatus === "not-applicable" ? "neutral" : "bad"}>{e.hashStatus}</Badge></td><td>{[e.error, e.skipReason, e.note, e.timeFilterApplied ? "time-filtered" : ""].filter(Boolean).join(" · ")}</td></tr>)}
    </tbody></table></div>
    {rows.length > 1000 && <p className="small muted">Showing the first 1000 matching rows; narrow the filter to see others.</p>}
  </section>);
}
