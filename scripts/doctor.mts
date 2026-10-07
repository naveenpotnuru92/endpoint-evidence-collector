// `npm run doctor` — checks the operator Mac's requirements and prints OK / FIX per item. Read-only; changes nothing.
import { existsSync, accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let bad = 0;
const row = (ok: boolean, name: string, detail: string, fix = "", required = true) => { console.log(`${ok ? "  OK   " : required ? "  FIX  " : "  SKIP "} ${name} — ${detail}${!ok && fix ? "  → " + fix : ""}`); if (!ok && required) bad++; };
const run = (c: string, a: string[]) => { try { return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };

console.log("Endpoint Evidence Collector — requirements check (operator Mac)\n");
const major = Number(process.versions.node.split(".")[0]); row(major >= 22, "Node.js >= 22", `found ${process.versions.node}`, "install from https://nodejs.org");
const npm = run("npm", ["-v"]); row(!!npm, "npm", npm || "not found", "comes with Node.js");
row(existsSync(join(process.cwd(), "node_modules")), "dependencies installed", "node_modules", "run: npm install");
row(existsSync(join(process.cwd(), "apps/ui/dist/index.html")), "UI built", "apps/ui/dist", "run: npm run build (npm run app does it for you)");
const ws = process.env.EEC_WORKSPACE ?? join(homedir(), ".endpoint-evidence-collector");
try { mkdirSync(ws, { recursive: true, mode: 0o700 }); accessSync(ws, constants.W_OK); row(true, "workspace writable", ws); } catch { row(false, "workspace writable", ws, "set EEC_WORKSPACE to a writable folder"); }
row(process.platform === "darwin", "operator OS", process.platform === "darwin" ? "macOS" : process.platform + " (planner is designed for a Mac; it also runs on Linux for development)", "", false);
row(existsSync("/bin/bash"), "/bin/bash (to test the Unix collector locally)", "/bin/bash", "", false);
row(existsSync("/Applications/Google Chrome.app"), "Google Chrome (optional, browser tests only)", "/Applications/Google Chrome.app", "install Chrome to run npm run test:e2e UI tests", false);
console.log(bad ? `\n${bad} item(s) need fixing.` : "\nAll required items OK."); process.exit(bad ? 1 : 0);
