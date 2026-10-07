import { useState } from "react";
import { ARTIFACTS } from "@eec/catalog";
import { OS_LIST } from "@eec/schema";
import { DEFAULT_SETTINGS, STORAGE_KEY, clearSettings, hasSavedSettings, saveSettings, type Settings as S } from "../lib/settings";
import { Badge, Notice, osName } from "../components/ui";

export function SettingsView({ settings, setSettings }: { settings: S; setSettings: (s: S) => void }) {
  const [msg, setMsg] = useState<string | null>(null); const [stored, setStored] = useState(hasSavedSettings());
  const t = settings.transport;
  const setT = (p: Partial<S["transport"]>) => setSettings({ ...settings, transport: { ...t, ...p } });
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
  return (<>
    <h1>Settings</h1>
    <Notice tone="info">Settings stay in memory until you press <strong>Save settings</strong>, which writes a single small key to this browser’s local storage. No plan content, personal data, secrets or remote endpoints are ever stored or configured here.</Notice>
    <div className="canvas" style={{ marginBottom: 20 }}>
      <h2>Appearance &amp; defaults</h2>
      <div className="row">
        <div className="field"><label className="lbl" htmlFor="theme" style={{ fontWeight: 600 }}>Theme</label><select id="theme" value={settings.theme} onChange={(e) => setSettings({ ...settings, theme: e.target.value as S["theme"] })}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
        <div className="field"><label className="lbl" htmlFor="dpf" style={{ fontWeight: 600 }}>Default per-file limit (MiB)</label><input id="dpf" type="number" min={1} value={settings.defaultPerFileMiB} onChange={(e) => setSettings({ ...settings, defaultPerFileMiB: Number(e.target.value) })} /></div>
        <div className="field"><label className="lbl" htmlFor="dtot" style={{ fontWeight: 600 }}>Default total limit (GiB)</label><input id="dtot" type="number" min={0.01} step="any" value={settings.defaultTotalGiB} onChange={(e) => setSettings({ ...settings, defaultTotalGiB: Number(e.target.value) })} /></div>
      </div>
      <p className="small muted">Defaults apply to new plans only.</p>
    </div>

    <div className="canvas" style={{ marginBottom: 20 }}>
      <h2>EDR transport profile</h2>
      <p className="small muted">Describes what you know about your internal EDR. Leave unknown values blank — they are shown as unknown and never guessed. No credentials or API endpoints are collected; this is not an integration.</p>
      <div className="row">
        <div className="field"><label className="lbl" htmlFor="tp-name" style={{ fontWeight: 600 }}>Profile name</label><input id="tp-name" type="text" value={t.name} onChange={(e) => setT({ name: e.target.value })} /></div>
        <div className="field"><label className="lbl" htmlFor="tp-to" style={{ fontWeight: 600 }}>Command timeout (min)</label><input id="tp-to" type="number" min={1} placeholder="unknown" value={t.timeoutMinutes ?? ""} onChange={(e) => setT({ timeoutMinutes: numOrNull(e.target.value) })} /></div>
        <div className="field"><label className="lbl" htmlFor="tp-part" style={{ fontWeight: 600 }}>Transfer part limit (MiB)</label><input id="tp-part" type="number" min={1} placeholder="unknown" value={t.partLimitMiB ?? ""} onChange={(e) => setT({ partLimitMiB: numOrNull(e.target.value) })} /></div>
        <div className="field"><label className="lbl" htmlFor="tp-int" style={{ fontWeight: 600 }}>Allowed interpreters</label><input id="tp-int" type="text" placeholder="unknown" value={t.interpreters} onChange={(e) => setT({ interpreters: e.target.value })} /></div>
        <div className="field"><label className="lbl" htmlFor="tp-sig" style={{ fontWeight: 600 }}>Script signing policy</label><select id="tp-sig" value={t.signingPolicy} onChange={(e) => setT({ signingPolicy: e.target.value as S["transport"]["signingPolicy"] })}><option value="unknown">Unknown</option><option value="none-required">Not required</option><option value="required">Signed scripts required</option></select></div>
        <div className="field"><label className="lbl" htmlFor="tp-wd" style={{ fontWeight: 600 }}>Working directory behaviour</label><select id="tp-wd" value={t.workingDirectory} onChange={(e) => setT({ workingDirectory: e.target.value as S["transport"]["workingDirectory"] })}><option value="unknown">Unknown</option><option value="script-directory">Script’s directory</option><option value="fixed-by-edr">Fixed by the EDR</option></select></div>
        <div className="field"><label className="lbl" htmlFor="tp-bg" style={{ fontWeight: 600 }}>Background process support</label><select id="tp-bg" value={t.background} onChange={(e) => setT({ background: e.target.value as S["transport"]["background"] })}><option value="unknown">Unknown (not validated)</option><option value="validated-supported">Validated: descendants survive</option><option value="not-supported">Not supported: EDR kills descendants</option></select></div>
      </div>
      {t.signingPolicy === "required" && <Notice tone="warn" title="Signing required">This release ships hashes only. Signing must be applied through your organization’s approved process before deployment (release blocker for such environments).</Notice>}
    </div>

    <div className="canvas" style={{ marginBottom: 20 }}>
      <h2>Local storage</h2>
      <p className="small">Browser key: <code>{STORAGE_KEY}</code> — currently {stored ? <Badge tone="info">saved</Badge> : <Badge>nothing saved</Badge>}. Saved plans are separate files in the app workspace folder (see Start).</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn primary" onClick={() => { saveSettings(settings); setStored(true); setMsg("Settings saved to local storage."); }}>Save settings</button>
        <button className="btn" onClick={() => { setSettings(DEFAULT_SETTINGS); setMsg("Reset to defaults (not yet saved)."); }}>Reset to defaults</button>
        <button className="btn danger" onClick={() => { clearSettings(); setStored(false); setMsg("Stored settings deleted."); }}>Delete stored settings</button>
        {msg && <span role="status" className="small muted">{msg}</span>}
      </div>
    </div>

    <div className="canvas">
      <h2>Support matrix</h2>
      <p className="small muted">Counts of catalog collectors by implementation state. “Verified” requires testing on target OS builds (and the internal EDR), which has not been performed for this release candidate.</p>
      <div className="tablewrap"><table><thead><tr><th>OS</th><th>Collectors</th><th>Planned only</th><th>Implemented, unverified</th><th>Verified</th></tr></thead><tbody>
        {OS_LIST.map((o) => { const a = ARTIFACTS.filter((x) => x.os.includes(o)); const c = (s: string) => a.filter((x) => (x.status[o] ?? "planned") === s).length; return <tr key={o}><td>{osName[o]}</td><td>{a.length}</td><td>{c("planned")}</td><td>{c("implemented-unverified")}</td><td>{c("verified")}</td></tr>; })}
      </tbody></table></div>
    </div>
  </>);
}
