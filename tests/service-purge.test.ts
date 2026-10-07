import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../apps/local-service/src/server.ts";

it("purges leftover import jobs at startup but keeps saved plans", () => {
  const ws = mkdtempSync(join(tmpdir(), "eec-purge-")); mkdirSync(join(ws, "jobs", "a".repeat(32)), { recursive: true }); mkdirSync(join(ws, "plans"), { recursive: true });
  writeFileSync(join(ws, "jobs", "a".repeat(32), "retrieval-index.json"), "{}"); writeFileSync(join(ws, "plans", "plan-0123456789ab.json"), "{}");
  createService({ workspace: ws });
  expect(existsSync(join(ws, "jobs", "a".repeat(32)))).toBe(false); expect(existsSync(join(ws, "plans", "plan-0123456789ab.json"))).toBe(true);
});
