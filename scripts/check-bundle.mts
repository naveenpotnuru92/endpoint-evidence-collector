// Starts the BUNDLED server (release/eec-*/server.mjs) from a copy outside the repo and checks it end to end.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rel = join(process.cwd(), "release"); const dir = readdirSync(rel).find((n) => /^eec-[\d.]+$/.test(n)); if (!dir) throw new Error("run npm run bundle first");
const tmp = mkdtempSync(join(tmpdir(), "eec-bundle-")); cpSync(join(rel, dir), join(tmp, "eec"), { recursive: true });
const child = spawn("node", ["server.mjs"], { cwd: join(tmp, "eec"), env: { PATH: process.env.PATH!, HOME: process.env.HOME!, EEC_NO_OPEN: "1", EEC_WORKSPACE: join(tmp, "ws") } });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const url = await new Promise<string>((res, rej) => { const t = setTimeout(() => rej(new Error("server did not start: " + log)), 8000); const i = setInterval(() => { const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(log); if (m) { clearTimeout(t); clearInterval(i); res(m[0]); } }, 50); });
let ok = true; const check = (n: string, c: boolean, d = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); ok &&= c; };
try {
  const html = await (await fetch(url)).text(); const token = /name="eec-token" content="([0-9a-f]{64})"/.exec(html)?.[1];
  check("bundled UI served with session token injected", !!token);
  const plan = { schemaVersion: 1, catalogVersion: "0.1.0", generatorVersion: "0.1.0", planId: "plan-0123456789ab", createdAtUtc: "2026-10-07T00:00:00Z", targetOs: "linux", preset: "targeted", artifactIds: ["lin.baseline.system"], userScope: { mode: "all-normal", names: [] }, includeSystemProfiles: false,
    timeWindow: { mode: "last-days", days: 7, startUtc: null, endUtc: null, displayTimezone: "UTC" }, outputRoot: "/var/tmp/eec-evidence", sizeLimits: { perFileBytes: 262144000, totalBytes: 2147483648, archivePartBytes: 262144000, freeSpaceReserveBytes: 536870912, maxArchiveParts: 64 }, runtimeBudgetSeconds: 900, customPaths: [], sensitiveSelections: [], executionMode: "foreground" };
  const r = await fetch(url + "api/generate", { method: "POST", headers: { "x-eec-token": token!, "content-type": "application/json" }, body: JSON.stringify({ plan }) });
  const j = await r.json() as { archiveSha256?: string; error?: string };
  check("bundled generator finds collector templates and builds a package", r.ok && /^[0-9a-f]{64}$/.test(j.archiveSha256 ?? ""), j.error ?? j.archiveSha256?.slice(0, 16));
  check("no token → 401", (await fetch(url + "api/health")).status === 401);
} finally { child.kill("SIGTERM"); }
process.exit(ok ? 0 : 1);
