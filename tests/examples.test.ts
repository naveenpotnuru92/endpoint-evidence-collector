import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePlan } from "@eec/schema";
import { generatePackage } from "@eec/generator";

const dir = join(process.cwd(), "examples/plans");
describe("example plans", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    it(`${f} validates and generates a package`, () => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")); expect(validatePlan(raw).ok).toBe(true);
      expect(generatePackage(raw).files.length).toBeGreaterThan(4);
    });
  }
});
