// Loopback-only local API. There is deliberately NO route that executes commands or reads arbitrary paths.
// Security properties (each covered by tests/service.test.ts):
//  - binds 127.0.0.1 only; Host and Origin are validated (DNS-rebinding / cross-origin defence)
//  - every /api route needs the ephemeral session token (x-eec-token)
//  - JSON bodies capped; uploads streamed to a private job dir with byte caps
//  - plan/job IDs are regex-validated before touching the filesystem; all writes stay under the workspace
//  - no CORS headers are ever emitted
import http from "node:http";
import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, createWriteStream, renameSync, statSync, readFileSync as rf } from "node:fs";
import { join, extname, normalize, sep } from "node:path";
import { validatePlan, migratePlan, newPlanId, GENERATOR_VERSION, type SavedPlan } from "@eec/schema";
import { ARTIFACTS, CATEGORIES, PRESETS_DEF, CATALOG_VERSION, resolveSelection } from "@eec/catalog";
import { generatePackage, GenerationError } from "@eec/generator";
import { verifyCollection, renderHtmlReport, summaryJson, DEFAULT_VERIFY_LIMITS, type VerifyReport } from "@eec/verifier";

export interface ServiceOptions { workspace: string; uiDir?: string; token?: string; port?: number; host?: string; maxUploadBytes?: number }
const MAX_JSON = 2 * 1024 * 1024;
const PLAN_ID = /^plan-[0-9a-f]{12}$/, JOB_ID = /^[0-9a-f]{32}$/, FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function createService(opts: ServiceOptions) {
  const token = opts.token ?? randomBytes(32).toString("hex");
  const ws = opts.workspace, plansDir = join(ws, "plans"), jobsDir = join(ws, "jobs");
  mkdirSync(plansDir, { recursive: true, mode: 0o700 });
  rmSync(jobsDir, { recursive: true, force: true });                 // import jobs are temporary: purge leftovers from any previous session
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const maxUpload = opts.maxUploadBytes ?? DEFAULT_VERIFY_LIMITS.maxImportBytes;
  const reports = new Map<string, VerifyReport>();
  let port = opts.port ?? 0; let uploadedByJob = new Map<string, number>();

  const send = (res: http.ServerResponse, code: number, body: unknown, type = "application/json") => {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, { "content-type": type + (type.startsWith("text/") || type === "application/json" ? "; charset=utf-8" : ""), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" });
    res.end(data);
  };
  const err = (res: http.ServerResponse, code: number, message: string, extra: object = {}) => send(res, code, { error: message, ...extra });
  const hostOk = (h: string | undefined) => !!h && (h === `127.0.0.1:${port}` || h === `localhost:${port}`);
  const originOk = (o: string | undefined) => o === undefined || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  const tokenOk = (t: string | string[] | undefined) => { if (typeof t !== "string") return false; const a = Buffer.from(t), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };

  function readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let n = 0;
      req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_JSON) { reject(Object.assign(new Error("Request body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); } });
      req.on("error", reject);
    });
  }
  const planFile = (id: string) => join(plansDir, id + ".json");
  const listPlans = () => readdirSync(plansDir).filter((n) => /^plan-[0-9a-f]{12}\.json$/.test(n)).map((n) => { try { const s = JSON.parse(readFileSync(join(plansDir, n), "utf8")) as SavedPlan; const p = s.plan as Record<string, unknown>; return { planId: p.planId, caseLabel: p.caseLabel ?? null, targetOs: p.targetOs, preset: p.preset, savedAtUtc: s.savedAtUtc, artifactCount: Array.isArray(p.artifactIds) ? p.artifactIds.length : 0 }; } catch { return null; } }).filter(Boolean);

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, path: string) {
    const m = req.method ?? "GET";
    if (path === "/api/health" && m === "GET") return send(res, 200, { ok: true, catalogVersion: CATALOG_VERSION, generatorVersion: GENERATOR_VERSION });
    if (path === "/api/catalog" && m === "GET") return send(res, 200, { catalogVersion: CATALOG_VERSION, categories: CATEGORIES, artifacts: ARTIFACTS, presets: PRESETS_DEF });
    if (path === "/api/plans/validate" && m === "POST") {
      const body = await readJson(req) as { plan?: unknown };
      const v = validatePlan(body.plan);
      if (!v.ok) return send(res, 200, { valid: false, issues: v.issues });
      return send(res, 200, { valid: true, resolution: resolveSelection(v.plan.artifactIds, v.plan.targetOs) });
    }
    if (path === "/api/plans/new-id" && m === "GET") return send(res, 200, { planId: newPlanId() });
    if (path === "/api/plans" && m === "GET") return send(res, 200, { plans: listPlans() });
    let mt = /^\/api\/plans\/(plan-[0-9a-f]{12})(\/duplicate)?$/.exec(path);
    if (mt) {
      const id = mt[1]!; if (!PLAN_ID.test(id)) return err(res, 400, "Invalid plan id");
      if (mt[2] && m === "POST") {
        if (!existsSync(planFile(id))) return err(res, 404, "Plan not found");
        const s = JSON.parse(readFileSync(planFile(id), "utf8")) as SavedPlan; const copy = { ...(s.plan as object), planId: newPlanId(), createdAtUtc: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
        const saved: SavedPlan = { savedFormat: 1, savedAtUtc: new Date().toISOString(), plan: copy };
        writeFileSync(planFile((copy as { planId: string }).planId), JSON.stringify(saved, null, 2), { mode: 0o600 });
        return send(res, 200, { planId: (copy as { planId: string }).planId });
      }
      if (m === "GET") {
        if (!existsSync(planFile(id))) return err(res, 404, "Plan not found");
        try { const s = JSON.parse(readFileSync(planFile(id), "utf8")) as SavedPlan; const mig = migratePlan(s.plan); return send(res, 200, { plan: mig.plan, migratedFrom: mig.migratedFrom, savedAtUtc: s.savedAtUtc }); }
        catch (e) { return err(res, 422, (e as Error).message); }
      }
      if (m === "PUT") {
        const body = await readJson(req) as { plan?: unknown }; const v = validatePlan(body.plan);
        if (!v.ok) return err(res, 422, "Plan is invalid; only valid plans can be saved.", { issues: v.issues });
        if (v.plan.planId !== id) return err(res, 400, "Plan id mismatch");
        writeFileSync(planFile(id), JSON.stringify({ savedFormat: 1, savedAtUtc: new Date().toISOString(), plan: v.plan } satisfies SavedPlan, null, 2), { mode: 0o600 });
        return send(res, 200, { saved: true });
      }
      if (m === "DELETE") { rmSync(planFile(id), { force: true }); return send(res, 200, { deleted: true }); }
    }
    if (path === "/api/generate" && m === "POST") {
      const body = await readJson(req) as { plan?: unknown };
      try {
        const r = generatePackage(body.plan);
        return send(res, 200, { archiveName: r.archiveName, archiveSha256: r.archiveSha256, packageManifest: r.packageManifest, unverified: r.unverified,
          instructions: new TextDecoder().decode(r.files.find((f) => f.name === "RUN-INSTRUCTIONS.txt")!.data), archiveBase64: Buffer.from(r.archive).toString("base64") });
      } catch (e) { if (e instanceof GenerationError) return err(res, 422, "Package cannot be generated.", { issues: e.issues }); throw e; }
    }
    // ---- imports: explicit file upload into a private job directory, then verification ----
    if (path === "/api/imports" && m === "POST") { const id = randomBytes(16).toString("hex"); mkdirSync(join(jobsDir, id), { recursive: true, mode: 0o700 }); uploadedByJob.set(id, 0); return send(res, 200, { jobId: id }); }
    mt = /^\/api\/imports\/([0-9a-f]{32})(?:\/(verify)|\/files\/([A-Za-z0-9._-]{1,128}))?$/.exec(path);
    if (mt) {
      const jobId = mt[1]!; const dir = join(jobsDir, jobId);
      if (!JOB_ID.test(jobId) || !existsSync(dir)) return err(res, 404, "Unknown import job");
      if (mt[3] && m === "PUT") {
        const name = mt[3]; if (!FILE_NAME.test(name)) return err(res, 400, "Invalid file name");
        const dest = join(dir, name), tmp = dest + ".part"; let n = 0; let aborted = false;
        const total0 = uploadedByJob.get(jobId) ?? 0;
        const ws2 = createWriteStream(tmp, { mode: 0o600 });
        req.on("data", (c: Buffer) => { n += c.length; if (!aborted && total0 + n > maxUpload) { aborted = true; req.unpipe(ws2); ws2.destroy(); req.resume(); } });
        try { await pipeline(req, ws2); } catch { /* aborted or client dropped: handled below */ }
        if (aborted || !req.complete) { rmSync(tmp, { force: true }); if (aborted) { return err(res, 413, "Import size limit exceeded"); } return err(res, 400, "Upload interrupted"); }
        renameSync(tmp, dest); uploadedByJob.set(jobId, total0 + n); return send(res, 200, { stored: name, bytes: n });
      }
      if (mt[2] === "verify" && m === "POST") {
        const files = Object.fromEntries(readdirSync(dir).filter((f) => FILE_NAME.test(f) && !f.endsWith(".part")).map((f) => [f, join(dir, f)]));
        const body = await readJson(req) as { planFileSha256?: string };
        const report = await verifyCollection({ files, planFileSha256: typeof body.planFileSha256 === "string" ? body.planFileSha256 : undefined });
        reports.set(jobId, report); return send(res, 200, report);
      }
      if (m === "DELETE") { rmSync(dir, { recursive: true, force: true }); reports.delete(jobId); uploadedByJob.delete(jobId); return send(res, 200, { deleted: true }); }
    }
    mt = /^\/api\/imports\/([0-9a-f]{32})\/report\.(json|html)$/.exec(path);
    if (mt && m === "GET") {
      const r = reports.get(mt[1]!); if (!r) return err(res, 404, "Run verification first");
      return mt[2] === "json" ? send(res, 200, summaryJson(r, { toolVersion: GENERATOR_VERSION }), "application/json") : send(res, 200, renderHtmlReport(r, { toolVersion: GENERATOR_VERSION, generatedUtc: new Date().toISOString() }), "text/html");
    }
    return err(res, 404, "Not found");
  }

  const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  function serveStatic(res: http.ServerResponse, path: string) {
    const root = opts.uiDir; if (!root || !existsSync(root)) return send(res, 200, "UI not built. Run: npm run build", "text/plain");
    let rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, ""); if (rel === "" || rel.endsWith(sep)) rel += "index.html";
    let file = join(root, rel); if (!file.startsWith(root + sep) && file !== root) return err(res, 403, "Forbidden");
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html");
    let body: Buffer | string = rf(file); const type = MIME[extname(file)] ?? "application/octet-stream";
    if (file.endsWith("index.html")) body = body.toString("utf8").replace("__EEC_TOKEN__", token);
    res.writeHead(200, { "content-type": type + (type.startsWith("text/") ? "; charset=utf-8" : ""), "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) return err(res, 403, "Invalid Host header");
      if (!originOk(req.headers.origin as string | undefined)) return err(res, 403, "Cross-origin request denied");
      const url = new URL(req.url ?? "/", "http://x"); const path = url.pathname;
      if (path.startsWith("/api/")) {
        if (!tokenOk(req.headers["x-eec-token"])) return err(res, 401, "Missing or invalid session token");
        return await handleApi(req, res, path);
      }
      if (req.method !== "GET") return err(res, 405, "Method not allowed");
      return serveStatic(res, path);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return err(res, status, status === 500 ? "Internal error" : (e as Error).message);   // never echo stack traces / paths
    }
  });
  server.requestTimeout = 10 * 60 * 1000; server.headersTimeout = 15_000;

  return {
    token, server,
    async listen(): Promise<{ port: number; url: string }> {
      await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
      port = (server.address() as { port: number }).port; return { port, url: `http://127.0.0.1:${port}/` };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
