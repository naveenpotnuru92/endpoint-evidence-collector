// Launcher: starts the loopback service and prints the URL. No external network calls, no telemetry.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createService } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = process.env.EEC_WORKSPACE ?? join(homedir(), ".endpoint-evidence-collector");
const svc = createService({ workspace, uiDir: [process.env.EEC_UI_DIR, join(here, "..", "..", "ui", "dist"), join(here, "ui")].filter((x): x is string => !!x).find((d) => existsSync(join(d, "index.html"))), port: Number(process.env.EEC_PORT ?? 0) || 0, token: process.env.EEC_DEV_TOKEN || undefined });
const { url } = await svc.listen();
console.log(`Endpoint Evidence Collector (planning + verification only; never runs endpoint commands)\n  UI:        ${url}\n  Workspace: ${workspace}\n  Stop with Ctrl+C.`);
if (process.env.EEC_NO_OPEN !== "1" && process.platform === "darwin") spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).unref();
process.on("SIGINT", async () => { await svc.close(); process.exit(0); });
