import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Badge, osName } from "../components/ui";

interface SavedMeta { planId: string; caseLabel: string | null; targetOs: "windows" | "macos" | "linux"; preset: string; savedAtUtc: string; artifactCount: number }
export function Start({ onNew, onOpen, onVerify }: { onNew: () => void; onOpen: (planId: string) => void; onVerify: () => void }) {
  const [plans, setPlans] = useState<SavedMeta[] | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ plans: SavedMeta[] }>("/api/plans").then((r) => setPlans(r.plans)).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);
  const del = async (id: string) => { if (!confirm(`Delete saved plan ${id}? This removes the local file.`)) return; await api(`/api/plans/${id}`, { method: "DELETE" }); load(); };
  const dup = async (id: string) => { await api(`/api/plans/${id}/duplicate`, { method: "POST" }); load(); };
  return (<>
    <h1>Endpoint evidence collection planner</h1>
    <p className="muted" style={{ maxWidth: 720 }}>Plan what to collect, generate a reviewed script package, hand it to your internal EDR, then verify what comes back. This app runs only on this Mac and never contacts or controls an endpoint.</p>
    <div className="start-grid">
      <div className="start-card"><h2>New collection plan</h2><p className="small muted">Choose OS, preset, artifacts, scope and limits, then export.</p><button className="btn primary" onClick={onNew}>Start a new plan</button></div>
      <div className="start-card"><h2>Verify retrieved collection</h2><p className="small muted">Select the index and archive parts you pulled through your EDR. Integrity and completeness are checked locally.</p><button className="btn" onClick={onVerify}>Verify a collection</button></div>
    </div>
    <h2>Saved plans</h2>
    {err && <div className="notice n-bad" role="alert">Could not reach the local service: {err}</div>}
    {plans && plans.length === 0 && <div className="empty">No saved plans yet. Plans are saved only when you press “Save plan locally”, and live in this app’s workspace folder where you can inspect or delete them.</div>}
    {plans && plans.length > 0 && <div className="tablewrap"><table><thead><tr><th>Plan</th><th>Case label</th><th>OS</th><th>Artifacts</th><th>Saved</th><th /></tr></thead><tbody>
      {plans.map((p) => <tr key={p.planId}><td className="mono">{p.planId}</td><td>{p.caseLabel ?? <span className="muted">—</span>}</td><td><Badge>{osName[p.targetOs]}</Badge></td><td>{p.artifactCount}</td><td>{p.savedAtUtc.slice(0, 16).replace("T", " ")} UTC</td>
        <td style={{ whiteSpace: "nowrap" }}><button className="btn" onClick={() => onOpen(p.planId)}>Open</button> <button className="btn" onClick={() => dup(p.planId)}>Duplicate</button> <button className="btn danger" onClick={() => del(p.planId)}>Delete</button></td></tr>)}
    </tbody></table></div>}
  </>);
}
