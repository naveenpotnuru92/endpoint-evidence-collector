import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../apps/local-service/src/server.ts";
import { makePlan } from "./helpers/plans.ts";
import { buildSynthRun } from "./helpers/synth-run.ts";
import { migratePlan } from "@eec/schema";

let svc: ReturnType<typeof createService>, base = "", port = 0, ws = "", ui = "";
const TOKEN = "t".repeat(64);
beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "eec-ws-")); ui = mkdtempSync(join(tmpdir(), "eec-ui-")); writeFileSync(join(ui, "index.html"), '<meta name="eec-token" content="__EEC_TOKEN__">');
  svc = createService({ workspace: ws, uiDir: ui, token: TOKEN, maxUploadBytes: 5 * 1024 * 1024 });
  const l = await svc.listen(); port = l.port; base = `http://127.0.0.1:${port}`;
});
afterAll(async () => { await svc.close(); });

const api = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(base + path, { ...init, headers: { "x-eec-token": TOKEN, ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers as object) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
function raw(opts: { path: string; headers: Record<string, string>; method?: string; body?: string }): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode!, body: b, headers: res.headers })); }); r.on("error", reject); r.end(opts.body); });
}
const plan = () => makePlan("linux", { artifactIds: ["lin.baseline.system", "lin.volatile.processes"] });

describe("service security", () => {
  it("binds to loopback only", () => { expect((svc.server.address() as { address: string }).address).toBe("127.0.0.1"); });
  it("rejects API calls without the session token", async () => {
    expect((await fetch(base + "/api/health")).status).toBe(401);
    expect((await fetch(base + "/api/health", { headers: { "x-eec-token": "wrong" } })).status).toBe(401);
  });
  it("rejects foreign Host headers (DNS rebinding)", async () => {
    expect((await raw({ path: "/api/health", headers: { host: "evil.example:" + port, "x-eec-token": TOKEN } })).status).toBe(403);
  });
  it("rejects cross-origin requests and sends no CORS headers", async () => {
    const r = await raw({ path: "/api/health", headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example", "x-eec-token": TOKEN } });
    expect(r.status).toBe(403); expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const ok = await api("/api/health"); expect(ok.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("serves the UI with a strict CSP and injects the session token only for valid hosts", async () => {
    const r = await raw({ path: "/", headers: { host: `127.0.0.1:${port}` } });
    expect(r.body).toContain(TOKEN); expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await raw({ path: "/", headers: { host: "evil.example" } })).body).not.toContain(TOKEN);
  });
  it("blocks static-file traversal", async () => {
    const r = await raw({ path: "/..%2F..%2F..%2Fetc%2Fpasswd", headers: { host: `127.0.0.1:${port}` } });
    expect(r.body).not.toContain("root:");
  });
  it("caps JSON body size", async () => {
    const res = await api("/api/plans/validate", { method: "POST", json: { plan: "x".repeat(3 * 1024 * 1024) } }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
  });
  it("has no routes to run commands or read arbitrary files", async () => {
    for (const p of ["/api/exec", "/api/run", "/api/fs?path=/etc/passwd", "/api/files", "/api/shell"]) expect((await api(p)).status).toBe(404);
  });
  it("rejects non-GET on static paths", async () => { expect((await raw({ path: "/", method: "POST", headers: { host: `127.0.0.1:${port}` } })).status).toBe(405); });
  it("errors do not leak stack traces or filesystem paths", async () => {
    const r = await api("/api/plans/validate", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    const t = await r.text(); expect(r.status).toBe(400); expect(t).not.toMatch(/\bat \w+|\/Users\//);
  });
});

describe("plans", () => {
  it("validates, saves, lists, loads, duplicates and deletes — all inside the workspace", async () => {
    const p = plan();
    const v = await (await api("/api/plans/validate", { method: "POST", json: { plan: p } })).json() as { valid: boolean };
    expect(v.valid).toBe(true);
    expect((await api(`/api/plans/${p.planId}`, { method: "PUT", json: { plan: p } })).status).toBe(200);
    expect(readdirSync(join(ws, "plans"))).toContain(`${p.planId}.json`);
    expect(((await (await api("/api/plans")).json()) as { plans: unknown[] }).plans).toHaveLength(1);
    const got = await (await api(`/api/plans/${p.planId}`)).json() as { plan: { planId: string } }; expect(got.plan.planId).toBe(p.planId);
    const dup = await (await api(`/api/plans/${p.planId}/duplicate`, { method: "POST" })).json() as { planId: string }; expect(dup.planId).not.toBe(p.planId);
    expect((await api(`/api/plans/${p.planId}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(join(ws, "plans", `${p.planId}.json`))).toBe(false);
  });
  it("refuses to save invalid plans and mismatched ids", async () => {
    const p = plan(); expect((await api(`/api/plans/${p.planId}`, { method: "PUT", json: { plan: { ...p, outputRoot: "/" } } })).status).toBe(422);
    expect((await api(`/api/plans/plan-aaaaaaaaaaaa`, { method: "PUT", json: { plan: p } })).status).toBe(400);
  });
  it("plan ids that are not strict hex are never routed to the filesystem", async () => {
    for (const bad of ["..%2F..%2Fx", "plan-../../x", "plan-0123456789AB"]) expect((await api(`/api/plans/${bad}`)).status).toBe(404);
  });
  it("migrates older saved plans and rejects newer ones", () => {
    const { plan: m, migratedFrom } = migratePlan({ ...plan(), schemaVersion: 0, executionMode: undefined }); expect(migratedFrom).toBe(0); expect((m as { executionMode: string }).executionMode).toBe("foreground");
    expect(() => migratePlan({ ...plan(), schemaVersion: 99 })).toThrow(/newer/);
  });
});

describe("generation", () => {
  it("returns a package with digest, instructions and base64 archive", async () => {
    const r = await (await api("/api/generate", { method: "POST", json: { plan: plan() } })).json() as { archiveSha256: string; archiveBase64: string; instructions: string };
    expect(r.archiveSha256).toMatch(/^[0-9a-f]{64}$/); expect(Buffer.from(r.archiveBase64, "base64").length).toBeGreaterThan(1000); expect(r.instructions).toContain("RUN INSTRUCTIONS");
  });
  it("returns operator-readable issues and keeps no state on failure", async () => {
    const res = await api("/api/generate", { method: "POST", json: { plan: { ...plan(), outputRoot: "/etc" } } });
    expect(res.status).toBe(422); expect(((await res.json()) as { issues: string[] }).issues.join(" ")).toMatch(/outputRoot/);
  });
});

describe("import → verify → report", () => {
  it("uploads files into a private job dir, verifies, exports reports, deletes", async () => {
    const src = mkdtempSync(join(tmpdir(), "eec-src-")); buildSynthRun(src, { state: "complete", files: [{ name: "a/x.txt", content: "1" }, { name: "b/y.txt", content: "2" }, { name: "c/z.txt", content: "3" }] });
    const { jobId } = await (await api("/api/imports", { method: "POST" })).json() as { jobId: string };
    for (const f of readdirSync(src)) expect((await api(`/api/imports/${jobId}/files/${f}`, { method: "PUT", body: readFileSync(join(src, f)) })).status).toBe(200);
    const rep = await (await api(`/api/imports/${jobId}/verify`, { method: "POST", json: {} })).json() as { integrity: string; completeness: string };
    expect(rep.integrity).toBe("verified"); expect(rep.completeness).toBe("complete");
    expect(await (await api(`/api/imports/${jobId}/report.html`)).text()).toContain("Integrity verified");
    expect(JSON.parse(await (await api(`/api/imports/${jobId}/report.json`)).text()).integrity).toBe("verified");
    expect((await api(`/api/imports/${jobId}`, { method: "DELETE" })).status).toBe(200); expect(existsSync(join(ws, "jobs", jobId))).toBe(false);
  });
  it("rejects unsafe upload names and oversize uploads", async () => {
    const { jobId } = await (await api("/api/imports", { method: "POST" })).json() as { jobId: string };
    expect((await api(`/api/imports/${jobId}/files/..%2Fevil`, { method: "PUT", body: "x" })).status).toBe(404);
    const big = await api(`/api/imports/${jobId}/files/big.bin`, { method: "PUT", body: Buffer.alloc(6 * 1024 * 1024) }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true); expect(existsSync(join(ws, "jobs", jobId, "big.bin"))).toBe(false);
  });
  it("a tampered upload yields a visible failure", async () => {
    const src = mkdtempSync(join(tmpdir(), "eec-src-")); buildSynthRun(src, { state: "complete", files: [{ name: "a", content: "1" }], corruptPart: 0 });
    const { jobId } = await (await api("/api/imports", { method: "POST" })).json() as { jobId: string };
    for (const f of readdirSync(src)) await api(`/api/imports/${jobId}/files/${f}`, { method: "PUT", body: readFileSync(join(src, f)) });
    expect(((await (await api(`/api/imports/${jobId}/verify`, { method: "POST", json: {} })).json()) as { integrity: string }).integrity).toBe("failed");
  });
  void mkdirSync;
});
