// Regenerates tests/fixtures/golden/* — SYNTHETIC collections (no real host/personal data) covering each result class.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSynthRun } from "../tests/helpers/synth-run.ts";

const base = join(process.cwd(), "tests/fixtures/golden"); rmSync(base, { recursive: true, force: true });
const F = [{ name: "baseline/system.txt", content: "synthetic baseline\n" }, { name: "volatile/processes.txt", content: "synthetic processes\n" }, { name: "browser/alice/Chrome/Default/History", content: "SYNTHETIC-HISTORY\n", profile: "alice/Chrome/Default" },
  { name: "logs/auth/auth.log", content: "synthetic auth\n" }, { name: "scheduled/cron/crontab", content: "# synthetic\n" }];
buildSynthRun(join(base, "complete"), { files: F, state: "complete" });
buildSynthRun(join(base, "complete-zip-windows"), { files: F, state: "complete", zip: true, targetOs: "windows" });
buildSynthRun(join(base, "partial"), { state: "partial", files: [...F.slice(0, 3), { name: "x", content: "", outcome: "failed", error: "Permission denied", artifactId: "lin.logs.auth" }, { name: "y", content: "", outcome: "skipped", skipReason: "limit:per-file-bytes (999 > 10)" }] });
buildSynthRun(join(base, "corrupted"), { files: F, state: "complete", corruptPart: 1 });
buildSynthRun(join(base, "missing-part"), { files: F, state: "complete", dropPart: 0 });
buildSynthRun(join(base, "interrupted"), { files: F.slice(0, 2), state: "cancelled", failedParts: [] });
writeFileSync(join(base, "README.txt"), "Synthetic golden collections for verifier regression tests. Regenerate with: npm run fixtures\nNo real endpoint data. Tarball/zip bytes are deterministic.\n");
console.log("golden fixtures written to", base);
