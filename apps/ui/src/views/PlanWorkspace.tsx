import { useEffect, useMemo, useRef, useState } from "react";
import { OS_LIST, planDigest, type TargetOs, type Preset, type ArtifactDef, type Plan } from "@eec/schema";
import { ARTIFACTS, CATEGORIES, PRESETS_DEF, CATALOG_VERSION, getArtifact, searchCatalog, groupSelectAll, presetIds, resolveSelection } from "@eec/catalog";
import { Draft, DEFAULT_OUTPUT, validateDraft, presetDiff, fieldForPath, artifactName } from "../lib/draft";
import { COMMON_TIMEZONES, isValidTz, zonedToUtcIso } from "../lib/time";
import { api, download, b64ToBytes } from "../lib/api";
import type { Settings } from "../lib/settings";
import { Badge, Notice, Field, osName, statusLabel, statusTone, sensLabel, sensTone, privLabel, timeLabel, fmtBytes } from "../components/ui";
import { ArtifactDrawer } from "../components/ArtifactDrawer";
import { Summary } from "../components/Summary";

const STEPS = ["Target", "Artifacts", "Scope & limits", "Review", "Export"] as const;
type GenState = { kind: "idle" } | { kind: "generating" } | { kind: "failed"; message: string; issues: string[] }
  | { kind: "success"; forDigest: string; archiveName: string; archiveSha256: string; instructions: string; archive: Uint8Array; files: { name: string; sha256: string; bytes: number }[]; unverified: string[] };

export function PlanWorkspace({ draft, setDraft, savedSnapshot, onSaved, settings, goStart }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; savedSnapshot: string | null; onSaved: (d: Draft) => void; settings: Settings; goStart: () => void }) {
  const [step, setStep] = useState(0);
  const [drawer, setDrawer] = useState<ArtifactDef | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [gen, setGen] = useState<GenState>({ kind: "idle" });
  const [digest, setDigest] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const { plan, issues } = useMemo(() => validateDraft(draft), [draft]);
  const dirty = savedSnapshot !== JSON.stringify(draft);
  useEffect(() => { let live = true; if (plan) planDigest(plan).then((d) => live && setDigest(d)); else setDigest(""); return () => { live = false; }; }, [plan]);
  const stale = gen.kind === "success" && gen.forDigest !== digest;
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => { if (pendingFocus.current) { document.getElementById(pendingFocus.current)?.focus(); pendingFocus.current = null; } });
  const goFix = (path: string) => { const f = fieldForPath(path); pendingFocus.current = f.field; setStep(f.step); };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const errFor = (field: string) => issues.filter((i) => i.path === field || fieldForPath(i.path).field === field).map((i) => i.message)[0];
  const os = draft.os;

  return (
    <div className="workspace">
      <nav aria-label="Plan steps"><ol className="rail">
        {STEPS.map((s, i) => <li key={s}><button aria-current={step === i ? "step" : undefined} onClick={() => setStep(i)}><span className="num" aria-hidden="true">{i + 1}</span>{s}
          {i === 3 && issues.length > 0 && <span className="flag"><Badge tone="bad">{issues.length}</Badge></span>}{i === 4 && stale && <span className="flag"><Badge tone="bad">stale</Badge></span>}</button></li>)}
      </ol></nav>

      <section className="canvas" aria-labelledby="step-title">
        {notices.map((n, i) => <Notice key={i} tone="info">{n}</Notice>)}
        {step === 0 && <TargetStep {...{ draft, set, setDraft, errFor, setNotices }} />}
        {step === 1 && os && <ArtifactsStep {...{ draft, setDraft, os, setNotices, openDrawer: setDrawer }} />}
        {step === 1 && !os && <div className="empty"><h2 id="step-title">Choose a target first</h2><p>Artifacts differ per operating system. Pick one in the Target step.</p><button className="btn primary" onClick={() => setStep(0)}>Go to Target</button></div>}
        {step === 2 && <ScopeStep {...{ draft, set, errFor, settings }} />}
        {step === 3 && <ReviewStep {...{ draft, plan, issues, goFix, setStep, openDrawer: setDrawer }} />}
        {step === 4 && <ExportStep {...{ draft, plan, issues, digest, gen, setGen, stale, settings, goFix }} />}

        <div className="footer-actions">
          <button className="btn" onClick={() => (step === 0 ? goStart() : setStep(step - 1))}>{step === 0 ? "← Start" : "← Back"}</button>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {saveMsg && <span className="small muted" role="status">{saveMsg}</span>}
            <button className="btn" disabled={!plan} title={plan ? "" : "Resolve issues before saving"} onClick={async () => { try { await api(`/api/plans/${draft.planId}`, { method: "PUT", json: { plan } }); onSaved(draft); setSaveMsg("Saved locally."); } catch (e) { setSaveMsg("Save failed: " + (e as Error).message); } }}>Save plan locally</button>
            {step < 4 && <button className="btn primary" onClick={() => setStep(step + 1)}>{step === 3 ? "Continue to export →" : "Next →"}</button>}
          </div>
        </div>
      </section>

      <Summary draft={draft} plan={plan} issues={issues} dirty={dirty} stale={stale} />
      {drawer && os && <ArtifactDrawer art={drawer} os={os} onClose={() => setDrawer(null)} />}
    </div>
  );
}

/* ---------------- Step 1: Target ---------------- */
function TargetStep({ draft, set, setDraft, errFor, setNotices }: { draft: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void; setDraft: (f: (d: Draft) => Draft) => void; errFor: (f: string) => string | undefined; setNotices: (n: string[]) => void }) {
  const [pending, setPending] = useState<Preset | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (pending) dlg.current?.showModal(); else dlg.current?.close(); }, [pending]);
  const chooseOs = (o: TargetOs) => {
    if (draft.os === o) return;
    const had = draft.artifactIds.length;
    setDraft((d) => ({ ...d, os: o, artifactIds: [], preset: "targeted", outputRoot: !d.outputRoot || Object.values(DEFAULT_OUTPUT).includes(d.outputRoot) ? DEFAULT_OUTPUT[o] : d.outputRoot, customPathsText: "" }));
    setNotices(had ? [`Switched to ${osName[o]}: ${had} artifact selection(s) from the previous OS were cleared, and custom paths were reset, so no stale selections carry over.`] : []);
  };
  const applyPreset = (p: Preset) => { setDraft((d) => ({ ...d, preset: p, artifactIds: p === "targeted" ? d.artifactIds : presetIds(p, d.os!) })); setNotices([]); setPending(null); };
  const choosePreset = (p: Preset) => { if (!draft.os) return; const diff = presetDiff(draft, p); if (p === "targeted" || draft.artifactIds.length === 0 || (diff.add.length === 0 && diff.remove.length === 0)) applyPreset(p); else setPending(p); };
  const diff = pending ? presetDiff(draft, pending) : { add: [], remove: [] };
  const counts = (o: TargetOs) => { const a = ARTIFACTS.filter((x) => x.os.includes(o)); return { total: a.length, impl: a.filter((x) => (x.status[o] ?? "planned") !== "planned").length, verified: a.filter((x) => x.status[o] === "verified").length }; };
  return (<>
    <h1 id="step-title">Target &amp; preset</h1>
    <p className="muted">Pick the endpoint operating system and a starting preset. Nothing here contacts an endpoint.</p>
    <Field id="caseLabel" label="Case label (optional)" hint="Free text for your records. It is never used in file names or paths." error={errFor("caseLabel")}>
      <input id="caseLabel" type="text" maxLength={80} value={draft.caseLabel} onChange={(e) => set("caseLabel", e.target.value)} />
    </Field>
    <fieldset aria-describedby="os-hint"><legend>Endpoint operating system</legend>
      <div className="pills" role="group" aria-label="Operating system">
        {OS_LIST.map((o) => { const c = counts(o); return <button key={o} id={o === "windows" ? "os" : undefined} className="pill" aria-pressed={draft.os === o} onClick={() => chooseOs(o)}>{osName[o]} <span className="small">{c.impl}/{c.total} collectors{c.verified === 0 ? " · none verified" : ""}</span></button>; })}
      </div>
      <p id="os-hint" className="hint muted small" style={{ marginTop: 8 }}>Support state: collectors are <strong>implemented but unverified</strong> until tested on target OS builds. Unsupported combinations cannot generate executable packages. Operator machine: macOS.</p>
      {errFor("os") && <div className="err">{errFor("os")}</div>}
    </fieldset>
    <h2>Preset</h2>
    <div className="cards">
      {PRESETS_DEF.map((p) => <button key={p.id} className="card" aria-pressed={draft.preset === p.id} disabled={!draft.os} onClick={() => choosePreset(p.id)}>
        <h3>{p.name}{draft.os && p.id !== "targeted" && <Badge>{p.artifactIdsByOs[draft.os].length} artifacts</Badge>}</h3><p className="small muted">{p.description}</p>{p.note && <p className="small">{p.note}</p>}
      </button>)}
    </div>
    {!draft.os && <p className="muted small">Choose an operating system to enable presets.</p>}
    <Notice tone="info">Defaults: all normal local profiles, last 7 days for time-filterable records, foreground execution, no custom files, no credential/session artifacts.</Notice>
    <dialog ref={dlg} onClose={() => setPending(null)} aria-labelledby="pd-title">
      <h2 id="pd-title">Apply “{PRESETS_DEF.find((p) => p.id === pending)?.name}” preset?</h2>
      <p>This will change your current selection. Review the preview first:</p>
      <h3>Will add ({diff.add.length})</h3><ul className="small">{diff.add.map((i) => <li key={i}>{artifactName(i)}</li>)}{diff.add.length === 0 && <li>nothing</li>}</ul>
      <h3>Will remove ({diff.remove.length})</h3><ul className="small">{diff.remove.map((i) => <li key={i}>{artifactName(i)}</li>)}{diff.remove.length === 0 && <li>nothing</li>}</ul>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" onClick={() => setPending(null)}>Keep my selection</button><button className="btn primary" onClick={() => pending && applyPreset(pending)}>Apply preset</button></div>
    </dialog>
  </>);
}

/* ---------------- Step 2: Artifacts ---------------- */
function ArtifactsStep({ draft, setDraft, os, setNotices, openDrawer }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; os: TargetOs; setNotices: (n: string[]) => void; openDrawer: (a: ArtifactDef) => void }) {
  const [q, setQ] = useState("");
  const sel = new Set(draft.artifactIds);
  const result = useMemo(() => searchCatalog(q, os), [q, os]);
  const cats = CATEGORIES.filter((c) => c.os.includes(os) && c.id !== "custom");
  const toggle = (id: string, on: boolean) => {
    const msgs: string[] = [];
    setDraft((d) => {
      let ids = new Set(d.artifactIds);
      if (on) { const r = resolveSelection([id], os); r.ids.forEach((x) => ids.add(x)); r.autoAdded.forEach((a) => msgs.push(`Added “${artifactName(a.id)}” automatically — required by “${artifactName(a.requiredBy)}”.`)); }
      else { ids.delete(id); for (const a of ARTIFACTS) if (a.dependsOn.includes(id) && ids.delete(a.id)) msgs.push(`Removed “${a.name}” because it depends on “${artifactName(id)}”.`); }
      return { ...d, artifactIds: [...ids], preset: d.preset === "targeted" ? "targeted" : d.preset };
    });
    setNotices(msgs);
  };
  const addMany = (ids: string[]) => setDraft((d) => ({ ...d, artifactIds: [...new Set([...d.artifactIds, ...ids])] }));
  const dropMany = (ids: string[]) => setDraft((d) => ({ ...d, artifactIds: d.artifactIds.filter((x) => !ids.includes(x)) }));
  return (<>
    <h1 id="step-title">Artifacts</h1>
    <p className="muted">Search by keyword (registry, cron, browser, startup, auth…) or browse. Search results are suggestions — they stay unselected until you choose them.</p>
    <Field id="artifact-search" label="Search categories">
      <input id="artifact-search" type="search" value={q} placeholder="e.g. scheduled, chrome history, auth" onChange={(e) => setQ(e.target.value)} />
    </Field>
    {q.trim() && (result.noMatch
      ? <div className="empty" role="status"><strong>No match for “{q}” on {osName[os]}.</strong><p className="small">Nothing was added. Try a different keyword, or browse the groups below. Some artifacts only exist on other operating systems.</p></div>
      : <div className="cat" role="region" aria-label="Search results"><header><div className="grow"><h3>{result.hits.length} suggestion{result.hits.length === 1 ? "" : "s"} <span className="muted small">(not selected)</span></h3></div><button className="btn" onClick={() => addMany(result.hits.filter((h) => h.artifact.sensitivity !== "sensitive-option").map((h) => h.artifact.id))}>Add all non-sensitive matches</button></header>
        {result.hits.map((h) => <div className="art" key={h.artifact.id}><div style={{ flex: 1 }}><strong>{h.artifact.name}</strong> <span className="muted small">matched on {h.matchedOn}</span></div>
          {sel.has(h.artifact.id) ? <Badge tone="ok">Selected</Badge> : <button className="btn" onClick={() => toggle(h.artifact.id, true)}>Add</button>}</div>)}
      </div>)}

    {cats.map((c) => {
      const items = ARTIFACTS.filter((a) => a.os.includes(os) && a.category === c.id);
      const selCount = items.filter((a) => sel.has(a.id)).length; const bulk = groupSelectAll(c.id, os);
      const groups = [...new Set(items.map((a) => a.group))];
      return (<section className="cat" key={c.id} aria-labelledby={`cat-${c.id}`}>
        <header><div className="grow"><h3 id={`cat-${c.id}`}>{c.name} <Badge tone={selCount ? "info" : "neutral"}>{selCount}/{items.length} selected</Badge></h3><div className="small muted">{c.description}</div></div>
          <button className="btn" onClick={() => addMany(bulk)} aria-label={`Select all non-sensitive in ${c.name}`}>Select all</button><button className="btn" onClick={() => dropMany(items.map((a) => a.id))} disabled={!selCount}>Clear</button></header>
        {c.id === "browser" && <div className="notice n-info" style={{ margin: "0 14px 8px" }}>Discovery rules (not real accounts): every in-scope local user is enumerated at run time; for each user the collector looks for Chromium-family “Default” and “Profile N” folders and Firefox profile folders in the browser’s fixed data location. History/downloads and extension/preference files are separate choices. Cookies, saved passwords, autofill and session data are never collected.</div>}
        {groups.map((g) => { const gi = items.filter((a) => a.group === g); const sens = gi.some((a) => a.sensitivity === "sensitive-option");
          return <div key={g}>{(groups.length > 1) && <div className="small muted" style={{ padding: "6px 14px 0", textTransform: "uppercase", letterSpacing: ".04em" }}>{sens ? "Sensitive option — separate explicit choice" : g.split(":")[1] ?? g}</div>}
            {gi.map((a) => { const st = a.status[os] ?? "planned"; return (
              <div className="art" key={a.id}>
                <input type="checkbox" id={`a-${a.id}`} checked={sel.has(a.id)} disabled={st === "planned"} onChange={(e) => toggle(a.id, e.target.checked)} aria-describedby={`d-${a.id}`} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label htmlFor={`a-${a.id}`}><strong>{a.name}</strong></label>
                  <div id={`d-${a.id}`} className="small muted">{a.description}</div>
                  <div className="meta"><Badge tone={statusTone[st]}>{statusLabel[st]}</Badge><Badge tone={sensTone[a.sensitivity]}>{sensLabel[a.sensitivity]}</Badge><Badge>{privLabel[a.privilege]}</Badge><Badge>{timeLabel[a.timeFilter]}</Badge><Badge>{a.userScope === "machine-wide" ? "Machine-wide" : "Per user"}</Badge></div>
                </div>
                <button className="btn link" onClick={() => openDrawer(a)}>Details</button>
              </div>); })}</div>; })}
      </section>);
    })}
    <div className="cat"><header><div className="grow"><h3>Custom files</h3><div className="small muted">Explicit literal paths are entered in the next step (Scope &amp; limits). Globs and network paths are not supported.</div></div></header></div>
    <p className="small muted">Catalog {CATALOG_VERSION}. Availability on a given endpoint is unknown until the collector runs there.</p>
  </>);
}

/* ---------------- Step 3: Scope & limits ---------------- */
function ScopeStep({ draft, set, errFor, settings }: { draft: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void; errFor: (f: string) => string | undefined; settings: Settings }) {
  const inv = (f: string) => (errFor(f) ? true : undefined);
  const tz = settings.transport;
  const tzKnown = isValidTz(draft.tz);
  const runtimeWarn = tz.timeoutMinutes !== null && Number(draft.runtimeMin) > tz.timeoutMinutes;
  const partWarn = tz.partLimitMiB !== null && Number(draft.partMiB) > tz.partLimitMiB;
  const bgOk = tz.background === "validated-supported";
  return (<>
    <h1 id="step-title">Scope &amp; limits</h1>
    <fieldset><legend>User scope</legend>
      {([["all-normal", "All normal local profiles (default)", "Every ordinary local account discovered on the endpoint, including inactive ones where readable."], ["named", "Named accounts", "Only the accounts you list (one per line)."], ["interactive", "Endpoint-detected interactive user", "Works only if exactly one interactive user is found; otherwise per-user artifacts are skipped and reported — the collector never guesses or uses a service account."]] as const).map(([v, l, h]) =>
        <div className="radio" key={v}><input type="radio" name="userMode" id={v === "all-normal" ? "userMode" : `um-${v}`} checked={draft.userMode === v} onChange={() => set("userMode", v)} /><label htmlFor={v === "all-normal" ? "userMode" : `um-${v}`}><strong>{l}</strong><div className="small muted">{h}</div></label></div>)}
      {draft.userMode === "named" && <Field id="namesText" label="Account names (one per line)" error={errFor("namesText")}><textarea id="namesText" aria-invalid={inv("namesText")} value={draft.namesText} onChange={(e) => set("namesText", e.target.value)} spellCheck={false} /></Field>}
      <div className="radio"><input type="checkbox" id="includeSystem" checked={draft.includeSystem} onChange={(e) => set("includeSystem", e.target.checked)} /><label htmlFor="includeSystem"><strong>Include system / service profiles</strong><div className="small muted">Off by default. Service and system accounts are distinguished from normal users on the endpoint.</div></label></div>
    </fieldset>

    <fieldset><legend>Time window</legend>
      <div className="row">
        <Field id="timeMode" label="Mode"><select id="timeMode" value={draft.timeMode} onChange={(e) => set("timeMode", e.target.value as Draft["timeMode"])}><option value="last-days">Last N days (relative to run time)</option><option value="range">Explicit range</option><option value="none">No time window</option></select></Field>
        <Field id="tz" label="Timezone for entered times" error={!tzKnown ? "Unknown timezone." : undefined}><input id="tz" list="tzlist" type="text" value={draft.tz} onChange={(e) => set("tz", e.target.value)} aria-invalid={!tzKnown || undefined} /><datalist id="tzlist">{COMMON_TIMEZONES.map((t) => <option key={t} value={t} />)}</datalist></Field>
      </div>
      {draft.timeMode === "last-days" && <Field id="days" label="Days" error={errFor("days")}><input id="days" type="number" min={1} value={draft.days} aria-invalid={inv("days")} onChange={(e) => set("days", e.target.value)} /></Field>}
      {draft.timeMode === "range" && <div className="row">
        <Field id="startLocal" label="Start" error={errFor("startLocal")} hint={draft.startLocal && `= ${zUtc(draft.startLocal, draft.tz)} UTC`}><input id="startLocal" type="datetime-local" value={draft.startLocal} aria-invalid={inv("startLocal")} onChange={(e) => set("startLocal", e.target.value)} /></Field>
        <Field id="endLocal" label="End" error={errFor("endLocal")} hint={draft.endLocal && `= ${zUtc(draft.endLocal, draft.tz)} UTC`}><input id="endLocal" type="datetime-local" value={draft.endLocal} aria-invalid={inv("endLocal")} onChange={(e) => set("endLocal", e.target.value)} /></Field></div>}
      <Notice tone="info">Time filtering applies only to record types that support it (marked “native”). Copied files such as databases or whole logs can contain older records.</Notice>
    </fieldset>

    <fieldset><legend>Limits</legend>
      <div className="row">
        <Field id="perFileMiB" label="Per-file limit (MiB)" error={errFor("perFileMiB")}><input id="perFileMiB" type="number" min={0.001} step="any" value={draft.perFileMiB} aria-invalid={inv("perFileMiB")} onChange={(e) => set("perFileMiB", e.target.value)} /></Field>
        <Field id="totalGiB" label="Total collected (GiB)" error={errFor("totalGiB")}><input id="totalGiB" type="number" min={0.001} step="any" value={draft.totalGiB} aria-invalid={inv("totalGiB")} onChange={(e) => set("totalGiB", e.target.value)} /></Field>
        <Field id="partMiB" label="Archive part size (MiB)" error={errFor("partMiB")} hint={partWarn ? <span className="err">Exceeds the transport profile’s part limit ({tz.partLimitMiB} MiB).</span> : undefined}><input id="partMiB" type="number" min={1} step="any" value={draft.partMiB} aria-invalid={inv("partMiB")} onChange={(e) => set("partMiB", e.target.value)} /></Field>
        <Field id="maxParts" label="Max archive parts" error={errFor("maxParts")}><input id="maxParts" type="number" min={1} value={draft.maxParts} aria-invalid={inv("maxParts")} onChange={(e) => set("maxParts", e.target.value)} /></Field>
        <Field id="reserveMiB" label="Free-space reserve (MiB)" error={errFor("reserveMiB")}><input id="reserveMiB" type="number" min={0} step="any" value={draft.reserveMiB} aria-invalid={inv("reserveMiB")} onChange={(e) => set("reserveMiB", e.target.value)} /></Field>
        <Field id="runtimeMin" label="Runtime budget (minutes)" error={errFor("runtimeMin")} hint={runtimeWarn ? <span className="err">Longer than the transport profile’s command timeout ({tz.timeoutMinutes} min).</span> : undefined}><input id="runtimeMin" type="number" min={0.5} step="any" value={draft.runtimeMin} aria-invalid={inv("runtimeMin")} onChange={(e) => set("runtimeMin", e.target.value)} /></Field>
      </div>
      <p className="small muted">Estimated collection size and runtime: <strong>unknown</strong> — they can only be measured on the endpoint. These are editable planning defaults to validate against your EDR, not predictions.</p>
    </fieldset>

    <fieldset><legend>Output &amp; custom files</legend>
      <Field id="outputRoot" label="Output root on the endpoint" error={errFor("outputRoot")} hint="Absolute endpoint path (not a path on this Mac). A new run-… directory is created inside it. Traversal, globs, network paths and protected system locations are rejected."><input id="outputRoot" type="text" value={draft.outputRoot} aria-invalid={inv("outputRoot")} onChange={(e) => set("outputRoot", e.target.value)} spellCheck={false} /></Field>
      <Field id="customPathsText" label="Custom files (one literal path per line)" error={errFor("customPathsText")} hint="Literal file paths only — no wildcards, no variables, no network paths. Symlinks are not followed."><textarea id="customPathsText" aria-invalid={inv("customPathsText")} value={draft.customPathsText} onChange={(e) => set("customPathsText", e.target.value)} spellCheck={false} /></Field>
    </fieldset>

    <fieldset><legend>Execution mode</legend>
      <div className="radio"><input type="radio" name="exec" id="executionMode" checked={draft.executionMode === "foreground"} onChange={() => set("executionMode", "foreground")} /><label htmlFor="executionMode"><strong>Foreground (default)</strong><div className="small muted">The EDR waits for the collector to finish.</div></label></div>
      <div className="radio"><input type="radio" name="exec" id="exec-bg" disabled={!bgOk} checked={draft.executionMode === "background"} onChange={() => set("executionMode", "background")} /><label htmlFor="exec-bg"><strong>Background</strong><div className="small muted">{bgOk ? "Enabled because your transport profile records validated background support." : "Disabled: background launch has not been validated against your EDR’s process-lifetime behaviour (Settings → EDR transport profile)."}</div></label></div>
    </fieldset>
  </>);
}
const zUtc = (l: string, tz: string) => zonedToUtcIso(l, tz) ?? "invalid";

/* ---------------- Step 4: Review ---------------- */
function ReviewStep({ draft, plan, issues, goFix, setStep, openDrawer }: { draft: Draft; plan: Plan | null; issues: { path: string; message: string }[]; goFix: (p: string) => void; setStep: (n: number) => void; openDrawer: (a: ArtifactDef) => void }) {
  const arts = draft.artifactIds.map((i) => getArtifact(i)).filter(Boolean) as ArtifactDef[];
  const os = draft.os; const personal = arts.filter((a) => a.sensitivity === "personal-data"); const cmd = arts.filter((a) => a.sensitivity === "sensitive-option");
  const deps = os ? resolveSelection(draft.artifactIds, os).autoAdded : [];
  const caps = [...new Set(arts.map((a) => a.privilege).filter((p) => p !== "none"))];
  const unverified = arts.filter((a) => os && (a.status[os] ?? "planned") !== "verified");
  const toStep = (n: number) => <button className="btn link" onClick={() => setStep(n)}>Edit</button>;
  return (<>
    <h1 id="step-title">Review</h1>
    {issues.length > 0 ? <Notice tone="bad" title={`${issues.length} issue(s) must be resolved before export`}><ul>{issues.map((i, k) => <li key={k}>{i.message} <button className="btn link" onClick={() => goFix(i.path)}>Fix</button></li>)}</ul></Notice> : <Notice tone="ok">Plan is valid against the schema. Review the details below, then export.</Notice>}
    {personal.length > 0 && <Notice tone="warn" title="Personal data">{personal.map((a) => a.name).join(", ")} contain browsing or user activity of the endpoint’s users. Handle retrieved output as sensitive personal data.</Notice>}
    {cmd.length > 0 && <Notice tone="warn" title="Sensitive option">Process command lines can contain secrets (tokens, passwords in arguments).</Notice>}
    {deps.length > 0 && <Notice tone="info" title="Automatically required">{deps.map((d) => `${artifactName(d.id)} (needed by ${artifactName(d.requiredBy)})`).join("; ")}</Notice>}
    {unverified.length > 0 && <Notice tone="warn" title="Unverified collectors">{unverified.length} selected collector(s) are implemented but not verified on target systems. Results may be partial or fail; the package will say so.</Notice>}

    <h2>Scope {toStep(2)}</h2>
    <table><tbody>
      <tr><th scope="row">Catalog version</th><td>{CATALOG_VERSION}</td></tr><tr><th scope="row">Target</th><td>{os ? osName[os] : "—"} {toStep(0)}</td></tr>
      <tr><th scope="row">User scope</th><td>{draft.userMode}{draft.userMode === "named" ? ` (${draft.namesText.trim().split(/\n/).filter(Boolean).join(", ")})` : ""}; system profiles {draft.includeSystem ? "included" : "excluded"}</td></tr>
      <tr><th scope="row">Time window</th><td>{plan ? (plan.timeWindow.mode === "none" ? "none" : plan.timeWindow.mode === "last-days" ? `last ${plan.timeWindow.days} days` : `${plan.timeWindow.startUtc} → ${plan.timeWindow.endUtc} (UTC)`) : "incomplete"} <span className="muted small">(native-filtered artifacts only)</span></td></tr>
      <tr><th scope="row">Limits</th><td>{plan ? `${fmtBytes(plan.sizeLimits.perFileBytes)} per file, ${fmtBytes(plan.sizeLimits.totalBytes)} total, parts ${fmtBytes(plan.sizeLimits.archivePartBytes)} (max ${plan.sizeLimits.maxArchiveParts}), reserve ${fmtBytes(plan.sizeLimits.freeSpaceReserveBytes)}, runtime ${plan.runtimeBudgetSeconds / 60} min` : "incomplete"}</td></tr>
      <tr><th scope="row">Planned output directory</th><td className="mono">{draft.outputRoot || "—"}{os === "windows" ? "\\" : "/"}run-&lt;timestamp&gt;-&lt;id&gt;</td></tr>
      <tr><th scope="row">Required capabilities</th><td>{caps.length ? caps.map((c) => privLabel[c]).join("; ") : "Ordinary privileges"}. The collector detects its identity and never elevates.</td></tr>
      <tr><th scope="row">Custom files</th><td>{draft.customPathsText.trim() ? draft.customPathsText.trim().split(/\n/).map((p, i) => <div key={i} className="mono">{p}</div>) : "none"}</td></tr>
    </tbody></table>

    <h2>Exact artifacts ({arts.length}) {toStep(1)}</h2>
    {arts.length === 0 ? <div className="empty">No artifacts selected. Go to <button className="btn link" onClick={() => setStep(1)}>Artifacts</button> to choose some.</div> :
      <div className="tablewrap"><table><thead><tr><th>Artifact</th><th>Sensitivity</th><th>Privilege</th><th>Time filter</th><th>Support</th><th /></tr></thead><tbody>
        {arts.map((a) => { const st = os ? (a.status[os] ?? "planned") : "planned"; return <tr key={a.id}><td>{a.name}<div className="mono muted">{a.id}</div></td><td><Badge tone={sensTone[a.sensitivity]}>{sensLabel[a.sensitivity]}</Badge></td><td>{privLabel[a.privilege]}</td><td>{timeLabel[a.timeFilter]}</td><td><Badge tone={statusTone[st]}>{statusLabel[st]}</Badge></td><td><button className="btn link" onClick={() => openDrawer(a)}>Details</button></td></tr>; })}
      </tbody></table></div>}
    <h2>Known caveats</h2>
    <ul className="small"><li>Live files can change during acquisition; copies may be internally inconsistent (flagged per file in the manifest).</li><li>Hashes support integrity checks only; they do not prove authenticity or legal chain of custody.</li><li>Output is not encrypted in this release. Protect retrieval and storage.</li><li>The collector writes output and leaves execution records (EDR/OS logs); cleanup is a separate deliberate step.</li></ul>
  </>);
}

/* ---------------- Step 5: Export ---------------- */
function ExportStep({ draft, plan, issues, digest, gen, setGen, stale, settings, goFix }: { draft: Draft; plan: Plan | null; issues: { path: string; message: string }[]; digest: string; gen: GenState; setGen: (g: GenState) => void; stale: boolean; settings: Settings; goFix: (p: string) => void }) {
  const t = settings.transport;
  const generate = async () => {
    if (!plan) return; setGen({ kind: "generating" });
    try {
      const r = await api<{ archiveName: string; archiveSha256: string; instructions: string; archiveBase64: string; packageManifest: { files: { name: string; sha256: string; bytes: number }[] }; unverified: string[] }>("/api/generate", { method: "POST", json: { plan } });
      setGen({ kind: "success", forDigest: digest, archiveName: r.archiveName, archiveSha256: r.archiveSha256, instructions: r.instructions, archive: b64ToBytes(r.archiveBase64), files: r.packageManifest.files, unverified: r.unverified });
    } catch (e) { setGen({ kind: "failed", message: (e as Error).message, issues: (e as { issues?: string[] }).issues ?? [] }); }
  };
  return (<>
    <h1 id="step-title">Export</h1>
    {!plan ? <Notice tone="bad" title="Export is blocked">Resolve the plan issues first.<ul>{issues.map((i, k) => <li key={k}>{i.message} <button className="btn link" onClick={() => goFix(i.path)}>Fix</button></li>)}</ul></Notice> : <>
      <h2>1 · Plan file (JSON)</h2>
      <p className="small muted">A data-only description of the request. It is not executable and contains no commands or credentials.</p>
      <p><button className="btn" onClick={() => download(`${plan.planId}.plan.json`, JSON.stringify(plan, null, 2) + "\n", "application/json")}>Download plan JSON</button> <span className="mono small muted">plan digest {digest.slice(0, 16)}…</span></p>

      <h2>2 · Script package</h2>
      <p className="small muted">Generated by reviewed static templates; plan values are read as data by the collector. This app never contacts or executes anything on an endpoint.</p>
      {gen.kind === "idle" && <button className="btn primary" onClick={generate}>Generate package</button>}
      {gen.kind === "generating" && <p role="status" aria-live="polite">Generating package…</p>}
      {gen.kind === "failed" && <Notice tone="bad" title="Generation failed — your plan is unchanged">{gen.message}{gen.issues.length > 0 && <ul>{gen.issues.map((i, k) => <li key={k}>{i}</li>)}</ul>} <button className="btn" onClick={generate}>Retry</button></Notice>}
      {gen.kind === "success" && (stale
        ? <Notice tone="bad" title="This export is out of date">The plan changed after the package was generated. The old package is hidden to avoid using it by mistake. <button className="btn primary" onClick={generate}>Regenerate</button></Notice>
        : <div role="status">
          <Notice tone="ok" title="Package ready">{gen.archiveName}</Notice>
          {gen.unverified.length > 0 && <Notice tone="warn" title="Support disclosure">{gen.unverified.length} collector(s) are unverified on target systems; the package’s RUN-INSTRUCTIONS say so.</Notice>}
          <p><button className="btn primary" onClick={() => download(gen.archiveName, gen.archive as BlobPart)}>Download {gen.archiveName}</button></p>
          <p className="small">Package SHA-256 (hashing only — this is <strong>not</strong> a signature):</p><div className="copybox">{gen.archiveSha256}</div>
          <h3 style={{ marginTop: 16 }}>Contents</h3>
          <div className="tablewrap"><table><thead><tr><th>File</th><th>Bytes</th><th>SHA-256</th></tr></thead><tbody>{gen.files.map((f) => <tr key={f.name}><td>{f.name}</td><td>{f.bytes}</td><td className="mono">{f.sha256.slice(0, 20)}…</td></tr>)}<tr><td>package-manifest.json</td><td colSpan={2} className="muted">lists the hashes above</td></tr></tbody></table></div>
          <h3 style={{ marginTop: 16 }}>Exact commands &amp; instructions (also inside the package as RUN-INSTRUCTIONS.txt)</h3>
          <p className="small muted">Paths marked EXAMPLE are placeholders for where you unpack the package; the output root below is your configured path.</p>
          <div className="copybox">{gen.instructions}</div>
        </div>)}

      <h2>3 · EDR hand-off checklist</h2>
      <p className="small muted">Profile: <strong>{t.name}</strong> (edit under Settings). Unknown values stay unknown.</p>
      <ul className="small">
        <li>Command timeout: {t.timeoutMinutes === null ? "unknown" : t.timeoutMinutes + " min"} · transfer part limit: {t.partLimitMiB === null ? "unknown" : t.partLimitMiB + " MiB"} · allowed interpreters: {t.interpreters || "unknown"} · signing policy: {t.signingPolicy} · working directory: {t.workingDirectory} · background: {t.background}</li>
        <li>Upload the package, unpack into a new empty directory, run the foreground command above, watch <code>status.json</code> in the run directory under <code className="mono">{draft.outputRoot || "<output root>"}</code>.</li>
        <li>Pull <code>retrieval-index.json</code>, <code>manifest.json</code>, <code>status.json</code> and every <code>part-*</code> file, then use <strong>Verify retrieved collection</strong> here.</li>
        <li>Only after verification: run the separate cleanup command (deliberate, not automatic, not secure erasure).</li>
      </ul>
    </>}
  </>);
}
