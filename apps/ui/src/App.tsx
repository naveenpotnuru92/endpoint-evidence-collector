import { useEffect, useState } from "react";
import { GENERATOR_VERSION } from "@eec/schema";
import { CATALOG_VERSION } from "@eec/catalog";
import { newDraft, planToDraft, type Draft } from "./lib/draft";
import { api } from "./lib/api";
import { loadSettings, type Settings } from "./lib/settings";
import { Start } from "./views/Start";
import { PlanWorkspace } from "./views/PlanWorkspace";
import { Verify } from "./views/Verify";
import { SettingsView } from "./views/Settings";

type View = "start" | "plan" | "verify" | "settings";
export function App() {
  const [view, setView] = useState<View>("start");
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [snapshot, setSnapshot] = useState<string | null>(null);   // JSON of the draft as last saved (for unsaved-edit marker)
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [openErr, setOpenErr] = useState<string | null>(null);

  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", settings.theme === "system" ? (dark.matches ? "dark" : "light") : settings.theme);
    apply(); dark.addEventListener("change", apply); return () => dark.removeEventListener("change", apply);
  }, [settings.theme]);

  const startNew = () => { const d = { ...newDraft(), perFileMiB: String(settings.defaultPerFileMiB), totalGiB: String(settings.defaultTotalGiB), ...(settings.transport.partLimitMiB ? { partMiB: String(Math.min(250, settings.transport.partLimitMiB)) } : {}) }; setDraft(d); setSnapshot(null); setView("plan"); };
  const open = async (id: string) => {
    try { const r = await api<{ plan: unknown; migratedFrom: number | null }>(`/api/plans/${id}`); const { validatePlan } = await import("@eec/schema"); const v = validatePlan(r.plan);
      if (!v.ok) { setOpenErr(`Saved plan ${id} is no longer valid: ${v.issues[0]?.message}`); return; } const d = planToDraft(v.plan); setDraft(d); setSnapshot(JSON.stringify(d)); setOpenErr(null); setView("plan"); }
    catch (e) { setOpenErr((e as Error).message); }
  };
  const leavePlan = (to: View) => { if (view === "plan" && JSON.stringify(draft) !== snapshot && draft.os && !confirm("You have unsaved plan edits. Leave anyway? (Edits stay in memory until you close this tab.)")) return; setView(to); };

  return (<>
    <a className="skip" href="#main">Skip to content</a>
    <header className="topbar">
      <button className="brand" onClick={() => leavePlan("start")}><span className="brand-mark" aria-hidden /> Evidence Collector</button>
      <nav className="topnav" aria-label="Primary">
        {([["start", "Start"], ["plan", "Plan"], ["verify", "Verify"], ["settings", "Settings"]] as const).map(([v, l]) => <button key={v} aria-current={view === v ? "page" : undefined} onClick={() => (v === "plan" ? setView("plan") : leavePlan(v))}>{l}</button>)}
      </nav>
      <div className="spacer" />
      <div className="versions" aria-label="Versions"><span className="preview-tag">Planning preview</span><span>planner {GENERATOR_VERSION}</span><span>catalog {CATALOG_VERSION}</span><span title="No telemetry, no external requests">offline · local only</span></div>
    </header>
    <main id="main" tabIndex={-1}>
      {openErr && <div className="notice n-bad" role="alert">{openErr}</div>}
      {view === "start" && <Start onNew={startNew} onOpen={open} onVerify={() => setView("verify")} />}
      {view === "plan" && <PlanWorkspace draft={draft} setDraft={(f) => setDraft(f)} savedSnapshot={snapshot} onSaved={(d) => setSnapshot(JSON.stringify(d))} settings={settings} goStart={() => leavePlan("start")} />}
      {view === "verify" && <Verify />}
      {view === "settings" && <SettingsView settings={settings} setSettings={setSettings} />}
    </main>
  </>);
}
