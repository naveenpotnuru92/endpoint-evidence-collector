// Writes example plans (no real personal data; placeholder paths). Regenerate: npx tsx scripts/make-examples.mts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makePlan } from "../tests/helpers/plans.ts";
import { presetIds } from "../packages/catalog/src/index.ts";

const dir = join(process.cwd(), "examples/plans"); mkdirSync(dir, { recursive: true });
const w = (n: string, p: object) => writeFileSync(join(dir, n), JSON.stringify(p, null, 2) + "\n");
w("macos-quick-triage.plan.json", makePlan("macos", { planId: "plan-aaaaaaaaaaaa", caseLabel: "EXAMPLE quick triage", preset: "quick-triage", artifactIds: presetIds("quick-triage", "macos") }));
w("windows-investigation.plan.json", makePlan("windows", { planId: "plan-bbbbbbbbbbbb", caseLabel: "EXAMPLE investigation (includes browser history = personal data)", preset: "investigation", artifactIds: presetIds("investigation", "windows") }));
w("linux-targeted-named-user.plan.json", makePlan("linux", { planId: "plan-cccccccccccc", caseLabel: "EXAMPLE targeted", artifactIds: ["lin.logs.auth", "lin.scheduled.cron", "lin.scheduled.timers"], userScope: { mode: "named", names: ["exampleuser"] },
  timeWindow: { mode: "range", days: null, startUtc: "2026-10-01T00:00:00Z", endUtc: "2026-10-07T00:00:00Z", displayTimezone: "UTC" }, customPaths: ["/etc/example.conf"] }));
