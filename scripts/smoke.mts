// ONE-COMMAND SMOKE TEST (npm run smoke): exercises the real product path over real HTTP and a real collector run.
//   service up -> catalog -> plan validate/save -> generate package -> unpack -> run collector on SYNTHETIC fixtures
//   -> upload results -> verify -> report -> cleanup.   Writes only to temp dirs. Exit code 0 only if every step passes.
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { createService } from "../apps/local-service/src/server.ts";
import { makePlan, makeFixtureUsers } from "../tests/helpers/plans.ts";

const results: [string, boolean, string][] = [];
const step = async (name: string, fn: () => Promise<string | void>) => { try { const d = (await fn()) ?? ""; results.push([name, true, d]); console.log(`  PASS  ${name}${d ? " — " + d : ""}`); } catch (e) { results.push([name, false, (e as Error).message]); console.log(`  FAIL  ${name} — ${(e as Error).message}`); } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

const host = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
const ws = mkdtempSync(join(tmpdir(), "eec-smoke-ws-")), tok = "smoke-" + "x".repeat(40);
const svc = createService({ workspace: ws, uiDir: join(process.cwd(), "apps/ui/dist"), token: tok }); const { url } = await svc.listen();
const call = async (p: string, init: RequestInit = {}) => { const r = await fetch(url.slice(0, -1) + p, { ...init, headers: { "x-eec-token": tok, "content-type": "application/json", ...(init.headers as object) } }); return r; };
console.log(`Smoke test against ${url} (host: ${process.platform})\n`);

await step("service rejects missing token", async () => { const r = await fetch(url + "api/health"); assert(r.status === 401, `status ${r.status}`); });
await step("UI is served with CSP", async () => { const r = await fetch(url); assert(r.ok && (r.headers.get("content-security-policy") ?? "").includes("default-src 'self'"), "no CSP / not built (run npm run build)"); });
await step("catalog loads", async () => { const j = await (await call("/api/catalog")).json() as { artifacts: unknown[] }; assert(j.artifacts.length > 30, "catalog too small"); return `${j.artifacts.length} artifacts`; });

if (!host) { console.log("  SKIP  collector run (needs macOS or Linux host)"); }
else {
  const P = host === "macos" ? "mac" : "lin"; const out = mkdtempSync(join(tmpdir(), "eec-smoke-out-")), fixtures = makeFixtureUsers();
  const plan = makePlan(host, { outputRoot: out, artifactIds: [`${P}.baseline.system`, `${P}.volatile.processes`, `${P}.browser.chromium.history`, `${P}.browser.firefox.history`, `${P}.userlogs.user`] });
  let pkgDir = "", runDir = "";
  await step("plan validates and saves", async () => { const v = await (await call("/api/plans/validate", { method: "POST", body: JSON.stringify({ plan }) })).json() as { valid: boolean }; assert(v.valid, "invalid"); assert((await call(`/api/plans/${plan.planId}`, { method: "PUT", body: JSON.stringify({ plan }) })).ok, "save failed"); });
  await step("package generates (deterministic digest shown)", async () => {
    const g = await (await call("/api/generate", { method: "POST", body: JSON.stringify({ plan }) })).json() as { archiveBase64: string; archiveSha256: string };
    const g2 = await (await call("/api/generate", { method: "POST", body: JSON.stringify({ plan }) })).json() as { archiveSha256: string }; assert(g.archiveSha256 === g2.archiveSha256, "non-deterministic");
    pkgDir = mkdtempSync(join(tmpdir(), "eec-smoke-pkg-")); const tgz = join(pkgDir, "p.tar.gz"); writeFileSync(tgz, Buffer.from(g.archiveBase64, "base64"));
    assert(gunzipSync(readFileSync(tgz)).length > 0, "bad gzip"); const r = spawnSync("tar", ["-xzf", tgz, "-C", pkgDir]); assert(r.status === 0, "untar failed");
    return g.archiveSha256.slice(0, 16) + "…";
  });
  await step("collector preflight passes", async () => { const r = spawnSync("/bin/bash", [join(pkgDir, "collector.sh"), "--preflight-only"], { encoding: "utf8" }); assert(r.status === 0, r.stderr); });
  await step("collector runs on synthetic fixtures", async () => {
    const r = spawnSync("/bin/bash", [join(pkgDir, "collector.sh"), "--run"], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME!, EEC_TEST_USERS_ROOT: fixtures } });
    assert(r.status === 0, `exit ${r.status}: ${r.stderr.slice(-300)}`); runDir = /RUN_DIR=(.*)/.exec(r.stderr)![1]!; assert(existsSync(join(runDir, "FINALIZED")), "no FINALIZED marker"); return readdirSync(runDir).filter((n) => n.startsWith("part-")).length + " part(s)";
  });
  await step("results upload + verify via API (integrity verified, complete)", async () => {
    const { jobId } = await (await call("/api/imports", { method: "POST" })).json() as { jobId: string };
    for (const f of readdirSync(runDir)) if (/^[A-Za-z0-9._-]+$/.test(f)) await call(`/api/imports/${jobId}/files/${f}`, { method: "PUT", body: readFileSync(join(runDir, f)), headers: { "content-type": "application/octet-stream" } });
    const rep = await (await call(`/api/imports/${jobId}/verify`, { method: "POST", body: "{}" })).json() as { integrity: string; completeness: string; totals: { hashMatch: number } };
    assert(rep.integrity === "verified" && rep.completeness === "complete", JSON.stringify({ i: rep.integrity, c: rep.completeness })); 
    const html = await (await call(`/api/imports/${jobId}/report.html`)).text(); assert(html.includes("Integrity verified"), "report missing"); await call(`/api/imports/${jobId}`, { method: "DELETE" });
    return `${rep.totals.hashMatch} file hashes matched`;
  });
  await step("tamper is detected", async () => {
    const part = readdirSync(runDir).find((n) => n.startsWith("part-"))!; const b = readFileSync(join(runDir, part)); b[Math.floor(b.length / 2)] ^= 0xff; writeFileSync(join(runDir, part), b);
    const { jobId } = await (await call("/api/imports", { method: "POST" })).json() as { jobId: string };
    for (const f of readdirSync(runDir)) if (/^[A-Za-z0-9._-]+$/.test(f)) await call(`/api/imports/${jobId}/files/${f}`, { method: "PUT", body: readFileSync(join(runDir, f)) });
    const rep = await (await call(`/api/imports/${jobId}/verify`, { method: "POST", body: "{}" })).json() as { integrity: string }; assert(rep.integrity === "failed", "tamper not detected");
  });
  await step("cleanup removes only the validated run dir", async () => {
    const r = spawnSync("/bin/bash", [join(pkgDir, "collector.sh"), "--cleanup", runDir, "--yes"], { encoding: "utf8" }); assert(r.status === 0 && !existsSync(runDir), r.stderr);
    const bad = spawnSync("/bin/bash", [join(pkgDir, "collector.sh"), "--cleanup", out, "--yes"], { encoding: "utf8" }); assert(bad.status === 2 && existsSync(out), "cleanup accepted a non-run directory");
  });
  void mkdirSync;
}
await svc.close();
const failed = results.filter((r) => !r[1]).length; console.log(`\n${results.length - failed}/${results.length} steps passed`); process.exit(failed ? 1 : 0);
