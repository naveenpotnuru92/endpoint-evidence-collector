// Verifies the COMMITTED golden collections (regression guard for the verifier's classification of results).
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { verifyCollection } from "@eec/verifier";
import { filesIn } from "./helpers/synth-run.ts";

const g = (n: string) => filesIn(join(process.cwd(), "tests/fixtures/golden", n));
const cases: [string, string, string][] = [
  ["complete", "verified", "complete"], ["complete-zip-windows", "verified", "complete"], ["partial", "verified", "partial"],
  ["corrupted", "failed", "complete"], ["missing-part", "failed", "incomplete"], ["interrupted", "verified", "incomplete"],
];
describe("golden collections", () => {
  it.each(cases)("%s → integrity %s / completeness %s", async (name, integrity, completeness) => {
    const r = await verifyCollection({ files: g(name) });
    expect(r.integrity).toBe(integrity);
    if (integrity === "verified" || name === "missing-part") expect(r.completeness).toBe(completeness);
  });
  it("a non-success result is never presented as a clean success", async () => {
    for (const n of ["corrupted", "missing-part", "partial", "interrupted"]) { const r = await verifyCollection({ files: g(n) }); expect(r.integrity === "verified" && r.completeness === "complete", n).toBe(false); }
  });
});
