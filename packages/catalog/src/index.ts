// Versioned, reviewed artifact catalog + search + dependency resolution.
import type { ArtifactDef, TargetOs } from "@eec/schema";
import { ARTIFACTS } from "./artifacts.js";
import { CATEGORIES } from "./categories.js";
import { PRESETS_DEF } from "./presets.js";

export const CATALOG_VERSION = "0.1.0";
export { ARTIFACTS, CATEGORIES, PRESETS_DEF };

const byId = new Map(ARTIFACTS.map((x) => [x.id, x]));
export const getArtifact = (id: string): ArtifactDef | undefined => byId.get(id);
export const artifactsForOs = (os: TargetOs): ArtifactDef[] => ARTIFACTS.filter((x) => x.os.includes(os));

export interface SearchHit { artifact: ArtifactDef; matchedOn: string; score: number }
export interface SearchResult { query: string; hits: SearchHit[]; noMatch: boolean }

/**
 * Keyword search over name / aliases / category aliases for one OS.
 * Unknown terms return noMatch=true — scope is NEVER expanded silently.
 */
export function searchCatalog(query: string, os: TargetOs): SearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { query, hits: [], noMatch: false };
  const tokens = q.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const art of artifactsForOs(os)) {
    const cat = CATEGORIES.find((c) => c.id === art.category);
    const fields: [string, string][] = [
      ["name", art.name.toLowerCase()],
      ...art.aliases.map((x): [string, string] => ["alias '" + x + "'", x.toLowerCase()]),
      ...(cat ? [["category", cat.name.toLowerCase()] as [string, string], ...cat.aliases.map((x): [string, string] => ["category alias '" + x + "'", x.toLowerCase()])] : []),
    ];
    let best: SearchHit | null = null;
    for (const [label, text] of fields) {
      // full phrase match scores higher than all-tokens-present
      const score = text === q ? 100 : text.includes(q) ? 60 : tokens.every((t) => text.includes(t)) ? 30 : 0;
      if (score > 0 && (!best || score > best.score)) best = { artifact: art, matchedOn: label, score };
    }
    if (best) hits.push(best);
  }
  hits.sort((a, b) => b.score - a.score || a.artifact.id.localeCompare(b.artifact.id));
  return { query, hits, noMatch: hits.length === 0 };
}

export interface Resolution { ids: string[]; autoAdded: { id: string; requiredBy: string }[]; unknown: string[]; wrongOs: string[] }

/** Resolve dependencies transparently; report auto-added items rather than hiding them. */
export function resolveSelection(ids: string[], os: TargetOs): Resolution {
  const out = new Set<string>();
  const autoAdded: Resolution["autoAdded"] = [];
  const unknown: string[] = [], wrongOs: string[] = [];
  const visit = (id: string, by: string | null) => {
    const art = byId.get(id);
    if (!art) { unknown.push(id); return; }
    if (!art.os.includes(os)) { wrongOs.push(id); return; }
    if (out.has(id)) return;
    out.add(id);
    if (by) autoAdded.push({ id, requiredBy: by });
    for (const d of art.dependsOn) visit(d, id);
  };
  const requested = new Set(ids);
  for (const id of ids) visit(id, null);
  // anything added only through dependencies is "auto"; anything also requested directly is not
  return { ids: [...out], autoAdded: autoAdded.filter((x) => !requested.has(x.id)), unknown, wrongOs };
}

/** Select-all inside a group — never includes selectAllExcluded (sensitive) entries. */
export function groupSelectAll(category: string, os: TargetOs): string[] {
  return artifactsForOs(os).filter((x) => x.category === category && !x.selectAllExcluded && x.sensitivity !== "sensitive-option").map((x) => x.id);
}

/** Sensitive-option selections implied by artifact IDs (used to keep plan.sensitiveSelections consistent). */
export function sensitiveSelectionsFor(ids: string[]): ("process-command-lines")[] {
  return ids.some((i) => getArtifact(i)?.sensitivity === "sensitive-option" && i.includes("cmdline")) ? ["process-command-lines"] : [];
}

export function presetIds(preset: string, os: TargetOs): string[] {
  return PRESETS_DEF.find((p) => p.id === preset)?.artifactIdsByOs[os] ?? [];
}
