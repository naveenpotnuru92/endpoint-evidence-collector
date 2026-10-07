import { useEffect, useRef } from "react";
import type { ArtifactDef, TargetOs } from "@eec/schema";
import { Badge, sensLabel, sensTone, privLabel, statusLabel, statusTone, timeLabel } from "./ui";

/** Exact sources, method, user/profile behaviour, privilege, filtering limits and support state for one artifact. */
export function ArtifactDrawer({ art, os, onClose }: { art: ArtifactDef; os: TargetOs; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const st = art.status[os] ?? "planned";
  return (<>
    <div className="scrim" onClick={onClose} />
    <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabIndex={-1} ref={ref}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><h2 id="drawer-title">{art.name}</h2><button className="btn" onClick={onClose}>Close</button></div>
      <p className="mono muted small">{art.id}</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <Badge tone={statusTone[st]}>{statusLabel[st]}</Badge><Badge tone={sensTone[art.sensitivity]}>{sensLabel[art.sensitivity]}</Badge><Badge>{privLabel[art.privilege]}</Badge><Badge>{timeLabel[art.timeFilter]}</Badge>
      </div>
      <p>{art.description}</p>
      <dl>
        <dt>Exact sources</dt><dd><ul>{art.sources.map((s) => <li key={s}><code>{s}</code></li>)}</ul></dd>
        <dt>Discovery</dt><dd>{art.discovery}</dd>
        <dt>Acquisition method</dt><dd>{art.acquisition} — {art.acquisitionDetail}</dd>
        <dt>User / profile behaviour</dt><dd>{art.userScope === "machine-wide" ? "Machine-wide (not per user)." : art.userScope === "per-user" ? "Collected for each in-scope account." : "Collected for each in-scope account and each nested browser profile."}</dd>
        <dt>Time-filter semantics</dt><dd>{art.timeFilterNote}</dd>
        <dt>Version constraints</dt><dd>{art.versionConstraints}</dd>
        <dt>Known failure modes</dt><dd><ul>{art.failureModes.map((f) => <li key={f}>{f}</li>)}</ul></dd>
        <dt>Output naming (example, not real data)</dt><dd><code>{art.output}</code></dd>
        {art.dependsOn.length > 0 && <><dt>Requires</dt><dd>{art.dependsOn.join(", ")}</dd></>}
        {art.references.length > 0 && <><dt>Documentation to validate against</dt><dd><ul>{art.references.map((r) => <li key={r} className="mono small">{r}</li>)}</ul></dd></>}
      </dl>
      <p className="muted small">Availability on a particular endpoint is unknown until the collector runs there; this panel shows catalog intent only.</p>
    </aside>
  </>);
}
