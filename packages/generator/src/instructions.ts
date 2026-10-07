// RUN-INSTRUCTIONS.txt and REVIEW-SUMMARY.txt text. Pure functions of (plan, resolved artifacts).
import type { Plan, ArtifactDef } from "@eec/schema";

const q = (s: string) => `"${s}"`;

export function outputPaths(plan: Plan) {
  const win = plan.targetOs === "windows";
  const sep = win ? "\\" : "/";
  const root = plan.outputRoot.replace(/[\\/]+$/, "");
  return { sep, root, runDirPattern: `${root}${sep}run-<timestamp>-<id>`, latest: `${root}${sep}latest-${plan.planId}.json` };
}

export function reviewSummary(plan: Plan, arts: ArtifactDef[], planSha: string): string {
  const L: string[] = [];
  L.push("COLLECTION PLAN REVIEW SUMMARY (preserved with the package)", "");
  L.push(`Plan ID:            ${plan.planId}`, `Plan file SHA-256:  ${planSha}`, `Catalog version:    ${plan.catalogVersion}`, `Generator version:  ${plan.generatorVersion}`);
  L.push(`Target OS:          ${plan.targetOs}`, `Preset:             ${plan.preset}`, `Execution mode:     ${plan.executionMode}`);
  L.push(`User scope:         ${plan.userScope.mode}${plan.userScope.names.length ? " (" + plan.userScope.names.length + " named)" : ""}; system/service profiles: ${plan.includeSystemProfiles ? "INCLUDED" : "excluded"}`);
  const tw = plan.timeWindow;
  L.push(`Time window:        ${tw.mode === "none" ? "none" : tw.mode === "last-days" ? `last ${tw.days} day(s)` : `${tw.startUtc} to ${tw.endUtc} (UTC)`}  [display tz: ${tw.displayTimezone}]`);
  L.push(`  NOTE: filtering applies only to artifacts marked 'native' below; other sources are copied whole and may contain older records.`);
  L.push(`Output root:        ${plan.outputRoot}`);
  const sl = plan.sizeLimits;
  L.push(`Limits:             per-file ${sl.perFileBytes} B, total ${sl.totalBytes} B, part ${sl.archivePartBytes} B, reserve ${sl.freeSpaceReserveBytes} B, max parts ${sl.maxArchiveParts}, runtime ${plan.runtimeBudgetSeconds}s`);
  L.push("", "Artifacts:");
  for (const a of arts) {
    const st = a.status[plan.targetOs] ?? "planned";
    L.push(`  - ${a.id}  [${a.sensitivity}] [priv: ${a.privilege}] [time-filter: ${a.timeFilter}] [support: ${st}]`);
  }
  if (plan.customPaths.length) { L.push("", "Custom literal paths:"); plan.customPaths.forEach((p) => L.push("  - " + JSON.stringify(p))); }
  if (plan.sensitiveSelections.length) L.push("", "Sensitive selections: " + plan.sensitiveSelections.join(", "));
  const personal = arts.filter((a) => a.sensitivity === "personal-data");
  if (personal.length) L.push("", `PERSONAL DATA: ${personal.length} selected artifact(s) contain personal data (e.g. browser history/downloads).`);
  L.push("", "Output is NOT encrypted. Treat retrieved parts and manifest (which lists paths) as sensitive evidence.");
  return L.join("\n") + "\n";
}

export function runInstructions(plan: Plan, arts: ArtifactDef[], unverified: string[], fileNames: string[]): string {
  const win = plan.targetOs === "windows";
  const { root, runDirPattern, latest } = outputPaths(plan);
  const L: string[] = [];
  const h = (t: string) => L.push("", t, "=".repeat(t.length));
  L.push("ENDPOINT EVIDENCE COLLECTOR — RUN INSTRUCTIONS", `Plan ${plan.planId}  |  target ${plan.targetOs}  |  generator ${plan.generatorVersion}  |  catalog ${plan.catalogVersion}`);
  if (unverified.length) {
    L.push("", "!! SUPPORT DISCLOSURE !!", "The following selected collectors are implemented but NOT verified on target systems; results may be incomplete or fail:");
    unverified.forEach((u) => L.push("   - " + u));
  }
  h("1. Verify the package (on the operator machine, before transfer)");
  L.push("Compare the package digest shown by the planner with:", win ? "   Get-FileHash -Algorithm SHA256 <package.zip>" : "   shasum -a 256 <package.tar.gz>     (or sha256sum on Linux)");
  L.push("A hash detects accidental change or tampering in transit. It is NOT a signature and does not prove who produced the package.");
  h("2. Transfer and unpack (via your internal EDR)");
  L.push("Upload the package using the EDR's file-transfer feature, then unpack it into a NEW empty directory.", "Paths below marked EXAMPLE are placeholders; choose your own.");
  if (win) L.push(`   EXAMPLE: Expand-Archive -LiteralPath ${q("C:\\Staging\\eec-package.zip")} -DestinationPath ${q("C:\\Staging\\eec")}`);
  else L.push(`   EXAMPLE: mkdir -p ${q("/var/tmp/eec")} && tar -xzf ${q("/var/tmp/eec-package.tar.gz")} -C ${q("/var/tmp/eec")}`);
  L.push(`Package files: ${fileNames.join(", ")}`);
  h("3. Execute (foreground — the default)");
  L.push("Run from the unpack directory (EXAMPLE path shown). The collector detects its own identity/privileges and never elevates.");
  if (win) L.push(`   & ${q("$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")} -NoProfile -NonInteractive -File ${q("C:\\Staging\\eec\\collector.ps1")} -Run`);
  else L.push(`   /bin/bash ${q("/var/tmp/eec/collector.sh")} --run`);
  L.push("Preflight only (no collection):", win ? `   ... -File ${q("C:\\Staging\\eec\\collector.ps1")} -PreflightOnly` : `   /bin/bash ${q("/var/tmp/eec/collector.sh")} --preflight-only`);
  L.push("", "Do NOT use execution-policy bypass or other protection overrides. If policy blocks the script, report it and use your organization's approved signing/deployment route.");
  L.push("", "Exit codes: 0 complete | 10 partial | 20 preflight failure | 30 interrupted or runtime budget exhausted | 40 packaging failure");
  if (plan.executionMode === "background") {
    h("3b. Background launch (NOT VALIDATED — test under your EDR first)");
    L.push("Background mode is only valid if your EDR leaves descendant processes alive after the command returns. If the EDR kills descendants, use foreground mode or an approved execution route; do not install services or scheduled tasks as a workaround.");
    if (win) L.push(`   Start-Process -FilePath ${q("$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")} -ArgumentList '-NoProfile','-NonInteractive','-File',${q("C:\\Staging\\eec\\collector.ps1")},'-Run' -WindowStyle Hidden`);
    else L.push(`   nohup /bin/bash ${q("/var/tmp/eec/collector.sh")} --run >/dev/null 2>&1 &`);
    L.push(`Launch receipt (written by the collector): ${latest}`);
  }
  h("4. Status");
  L.push(`Configured output root: ${root}`, `Run directory:          ${runDirPattern}`, `Status file:            <run directory>${win ? "\\" : "/"}status.json   (state: preflight|collecting|packaging|complete|partial|failed|cancelled)`);
  L.push(`A run is finished only when the file FINALIZED exists next to status.json. Without it, the run is incomplete or was interrupted.`);
  h("5. Retrieve (via your internal EDR)");
  L.push("Pull these from the run directory:", "   retrieval-index.json   (external index: expected parts, sizes, SHA-256)", "   manifest.json          (per-file source/outcome/hash — contains paths; sensitive)", "   status.json, run.log", `   part-001.${win ? "zip" : "tar.gz"}, part-002.${win ? "zip" : "tar.gz"}, ...   (independently readable archive parts)`);
  L.push("Then import them into the planner's Verify screen. Output is NOT encrypted; store and transfer it as sensitive evidence.");
  h("6. Cleanup (separate, deliberate, only after retrieval verification)");
  L.push("Cleanup deletes ONE collector-owned run directory (it checks the name and an ownership marker). It is ordinary deletion, not secure erasure.");
  if (win) L.push(`   ... -File ${q("C:\\Staging\\eec\\collector.ps1")} -Cleanup ${q("<run directory>")} -Yes`);
  else L.push(`   /bin/bash ${q("/var/tmp/eec/collector.sh")} --cleanup ${q("<run directory>")} --yes`);
  L.push("Also remove the unpacked package directory yourself if desired.");
  h("7. Footprint and limitations");
  L.push("- The collector writes only inside the run directory and records process/command execution that your EDR and the OS log.", "- Live files can change during acquisition; copies of databases/logs may be internally inconsistent (see manifest consistencyNote).", "- Time filtering applies only to artifacts marked 'native'; copied files can contain older records.", "- Hashes support integrity checking only; they do not prove source authenticity or legal chain of custody.", "- If the EDR terminates the process, finalization may not occur; the run directory is then clearly incomplete (no FINALIZED).", "- The collector does not collect credentials, cookies or session tokens, and makes no network connections.");
  if (plan.targetOs === "macos") L.push("- macOS privacy controls (TCC) may block reads of some user data; such failures are recorded. The collector never grants itself Full Disk Access.");
  return L.join("\n") + "\n";
}
