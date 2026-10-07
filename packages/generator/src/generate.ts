// Deterministic package assembly. Pure aside from reading static templates from /collectors.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlan, GENERATOR_VERSION, type Plan, type ArtifactDef } from "@eec/schema";
import { getArtifact, resolveSelection, CATALOG_VERSION } from "@eec/catalog";
import { buildConf } from "./conf.js";
import { reviewSummary, runInstructions } from "./instructions.js";
import { zipStore, tarGz, type PkgFile } from "./archive.js";

// Template location: repo layout (packages/generator/src -> ../../../collectors) or release-bundle layout (<bundle>/collectors).
// EEC_COLLECTORS_DIR can override. Only static, reviewed files are ever read from here.
const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECTORS = [process.env.EEC_COLLECTORS_DIR, join(HERE, "..", "..", "..", "collectors"), join(HERE, "collectors")].filter((x): x is string => !!x).find((d) => existsSync(join(d, "_shared", "unix-core.sh"))) ?? join(HERE, "collectors");
const read = (...p: string[]) => readFileSync(join(COLLECTORS, ...p), "utf8");
const enc = new TextEncoder();
const sha = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");

export class GenerationError extends Error {
  constructor(public issues: string[]) { super(issues.join("; ")); }
}

export interface PackageResult {
  files: PkgFile[];                    // individual files (for inspection / tests)
  archive: Uint8Array; archiveName: string;
  archiveSha256: string;               // digest of the downloadable archive
  packageManifest: { generatorVersion: string; catalogVersion: string; planId: string; targetOs: string; files: { name: string; sha256: string; bytes: number }[] };
  unverified: string[];                // selected collectors that are not 'verified'
}

/** Assemble the OS collector script from reviewed static parts. Pure concatenation, no templating of plan data. */
export function assembleCollector(os: Plan["targetOs"]): string {
  if (os === "windows") return read("windows", "collector.ps1");
  const header = `#!/bin/bash\n# Endpoint Evidence Collector ${GENERATOR_VERSION} (${os}) — static reviewed template; reads collector.conf as data.\n`;
  return [header, read("_shared", "unix-core.sh"), read("_shared", "unix-browsers.sh"), read(os, "artifacts.sh"), read("_shared", "unix-main.sh")].join("\n");
}

/** Check the plan can become an executable package for its target OS. Throws GenerationError with operator-readable issues. */
export function checkGeneratable(plan: Plan): ArtifactDef[] {
  const issues: string[] = [];
  const res = resolveSelection(plan.artifactIds, plan.targetOs);
  res.unknown.forEach((i) => issues.push(`Unknown artifact '${i}'.`));
  res.wrongOs.forEach((i) => issues.push(`Artifact '${i}' does not apply to ${plan.targetOs}.`));
  if (res.autoAdded.length) issues.push(`Missing required dependencies: ${res.autoAdded.map((a) => `${a.id} (needed by ${a.requiredBy})`).join(", ")}. Add them explicitly.`);
  if (plan.catalogVersion !== CATALOG_VERSION) issues.push(`Plan catalog ${plan.catalogVersion} differs from installed catalog ${CATALOG_VERSION}; regenerate the plan.`);
  const arts: ArtifactDef[] = [];
  for (const id of plan.artifactIds) {
    const a = getArtifact(id); if (!a || !a.os.includes(plan.targetOs)) continue;
    const st = a.status[plan.targetOs] ?? "planned";
    if (st === "planned") issues.push(`Artifact '${id}' is only planned for ${plan.targetOs}; no collector exists, so no executable package can be generated.`);
    if (a.sensitivity === "sensitive-option" && a.id.includes("cmdline") && !plan.sensitiveSelections.includes("process-command-lines"))
      issues.push(`Artifact '${id}' requires the explicit 'process-command-lines' sensitive selection.`);
    arts.push(a);
  }
  if (plan.sensitiveSelections.includes("process-command-lines") && !arts.some((a) => a.id.includes("cmdline")))
    issues.push("Sensitive selection 'process-command-lines' is set but no command-line artifact is selected.");
  if (issues.length) throw new GenerationError(issues);
  return arts;
}

export function generatePackage(input: unknown): PackageResult {
  const v = validatePlan(input);
  if (!v.ok) throw new GenerationError(v.issues.map((i) => `${i.path}: ${i.message}`));
  const plan = v.plan;
  const arts = checkGeneratable(plan);

  const planJson = JSON.stringify(plan, null, 2) + "\n";            // data only, never executable
  const planSha = sha(planJson);
  const unverified = arts.filter((a) => (a.status[plan.targetOs] ?? "planned") !== "verified").map((a) => `${a.id} (${a.status[plan.targetOs] ?? "planned"})`);
  const win = plan.targetOs === "windows";
  const collectorName = win ? "collector.ps1" : "collector.sh";

  const files: PkgFile[] = [
    { name: collectorName, data: enc.encode(assembleCollector(plan.targetOs)), mode: 0o644 },
    { name: "collection-plan.json", data: enc.encode(planJson), mode: 0o600 },
  ];
  if (!win) files.push({ name: "collector.conf", data: enc.encode(buildConf(plan, planSha)), mode: 0o600 });
  files.push({ name: "REVIEW-SUMMARY.txt", data: enc.encode(reviewSummary(plan, arts, planSha)), mode: 0o644 });
  const names = [...files.map((f) => f.name), "RUN-INSTRUCTIONS.txt", "package-manifest.json"];
  files.push({ name: "RUN-INSTRUCTIONS.txt", data: enc.encode(runInstructions(plan, arts, unverified, names)), mode: 0o644 });

  const packageManifest = {
    generatorVersion: GENERATOR_VERSION, catalogVersion: plan.catalogVersion, planId: plan.planId, targetOs: plan.targetOs,
    files: files.map((f) => ({ name: f.name, sha256: sha(f.data), bytes: f.data.length })),
  };
  files.push({ name: "package-manifest.json", data: enc.encode(JSON.stringify(packageManifest, null, 2) + "\n"), mode: 0o644 });

  const archive = win ? zipStore(files) : tarGz(files);
  return { files, archive, archiveName: `eec-${plan.planId}-${plan.targetOs}.${win ? "zip" : "tar.gz"}`, archiveSha256: sha(archive), packageManifest, unverified };
}
