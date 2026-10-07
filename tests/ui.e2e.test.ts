// BROWSER END-TO-END: real local service + built UI + system Chrome (via playwright-core). Skipped if Chrome or the UI build is missing.
// Covers: keyboard-only plan completion, OS switching without stale artifacts, preset preview, honest no-match,
// validation messaging, export + stale-export handling, verify flow, themes/narrow layouts, a11y (axe), and "no external network".
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createService } from "../apps/local-service/src/server.ts";
import { buildSynthRun } from "./helpers/synth-run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UI = join(root, "apps/ui/dist");
const can = existsSync(CHROME) && existsSync(join(UI, "index.html"));
const SHOTS = join(root, "docs/screenshots");
const axeSrc = readFileSync(join(root, "node_modules/axe-core/axe.min.js"), "utf8");

describe.runIf(can)("UI end-to-end (Chrome)", () => {
  let svc: ReturnType<typeof createService>, browser: Browser, page: Page, url = ""; const requests: string[] = []; const consoleErrors: string[] = [];
  beforeAll(async () => {
    svc = createService({ workspace: mkdtempSync(join(tmpdir(), "eec-uiws-")), uiDir: UI }); url = (await svc.listen()).url;
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", acceptDownloads: true });
    page = await ctx.newPage(); page.on("dialog", (d) => void d.accept()); page.on("request", (r) => requests.push(r.url())); page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    mkdirSync(SHOTS, { recursive: true });
  });
  afterAll(async () => { await browser?.close(); await svc?.close(); });
  const rail = (n: RegExp) => page.getByRole("navigation", { name: "Plan steps" }).getByRole("button", { name: n });
  const axe = async (label: string) => {
    await page.evaluate(axeSrc);
    const r = await page.evaluate(async () => (await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { html: string }[] }[] }> } }).axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.html.slice(0, 120) })));
    expect(r, `axe violations on ${label}`).toEqual([]);
  };

  it("start screen: no endpoint claims, version indicator visible", async () => {
    await page.goto(url);
    await page.getByRole("heading", { name: /Endpoint evidence collection planner/ }).waitFor();
    expect(await page.locator(".versions").innerText()).toMatch(/Planning preview[\s\S]*planner 0\.1\.0[\s\S]*catalog 0\.1\.0/);
    expect(await page.locator("body").innerText()).not.toMatch(/connected|online endpoints|live endpoint/i);
    await page.screenshot({ path: join(SHOTS, "01-start.png") }); await axe("start");
  });

  it("keyboard-only: complete a Linux plan, export JSON and generate a package", async () => {
    await page.getByRole("button", { name: "Start a new plan" }).focus(); await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: /Target & preset/ }).waitFor();
    // review step with nothing chosen shows a blocking issue
    await rail(/^Review/).click();
    expect(await page.locator(".canvas").innerText()).toMatch(/issue\(s\) must be resolved/); expect(await page.locator(".canvas").innerText()).toMatch(/Choose a target operating system/);
    await rail(/^Target/).click();
    await page.getByRole("button", { name: /^Linux/ }).focus(); await page.keyboard.press("Enter");
    // presets enabled -> quick triage via keyboard
    await page.getByRole("button", { name: /^Quick triage/ }).focus(); await page.keyboard.press("Enter");
    expect(await page.locator(".summary").innerText()).toMatch(/target\s*linux/i); await page.screenshot({ path: join(SHOTS, "02-target.png") });
    await page.getByRole("button", { name: "Next →" }).click();
    await page.getByRole("heading", { name: "Artifacts", exact: true }).waitFor();
    // honest no-match
    await page.locator("#artifact-search").fill("quantum flux");
    await page.getByText(/No match for/).waitFor(); expect(await page.getByText(/Nothing was added/).count()).toBe(1);
    // alias search yields unselected suggestions
    await page.locator("#artifact-search").fill("journalctl");
    await page.getByRole("region", { name: "Search results" }).waitFor();
    expect(await page.locator("#a-lin\\.logs\\.journal").isChecked()).toBe(false);
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
    expect(await page.locator("#a-lin\\.logs\\.journal").isChecked()).toBe(true);
    // sensitive subgroup is never selected by "select all"
    await page.locator("#artifact-search").fill("");
    await page.getByRole("button", { name: "Select all non-sensitive in Volatile snapshot" }).click();
    expect(await page.locator("#a-lin\\.volatile\\.processes").isChecked()).toBe(true);
    expect(await page.locator("#a-lin\\.volatile\\.processes\\.cmdline").isChecked()).toBe(false);
    await page.screenshot({ path: join(SHOTS, "03-artifacts.png"), fullPage: false }); await axe("artifacts");
    // drawer opens and closes with Escape
    await page.getByRole("button", { name: "Details" }).first().click(); await page.getByRole("dialog").waitFor(); await page.screenshot({ path: join(SHOTS, "04-drawer.png") });
    await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Next →" }).click();
    // scope: invalid input shows field-level message
    await page.getByRole("heading", { name: /^Scope/ }).waitFor();
    await page.locator("#outputRoot").fill("/etc"); await page.locator("#totalGiB").fill("");
    await rail(/^Review/).click();
    const rv = await page.locator(".canvas").innerText(); expect(rv).toMatch(/protected system location/); expect(rv).toMatch(/Total limit must be a number/);
    await page.getByRole("button", { name: "Fix" }).first().click();
    expect(await page.evaluate(() => document.activeElement?.id)).toMatch(/totalGiB|outputRoot/);
    await page.locator("#totalGiB").fill("2"); await page.locator("#outputRoot").fill("/var/tmp/eec-evidence"); await page.locator("#customPathsText").fill("/var/tmp/José Müller/notes file.txt");
    await page.screenshot({ path: join(SHOTS, "05-scope.png") }); await axe("scope");
    await rail(/^Review/).click();
    await page.getByText(/Plan is valid against the schema/).waitFor(); await page.screenshot({ path: join(SHOTS, "06-review.png") });
    expect(await page.locator(".canvas").innerText()).toMatch(/Unverified collectors/);
    await page.getByRole("button", { name: /Continue to export/ }).click();
    // export JSON
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download plan JSON" }).click()]);
    const plan = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(plan.targetOs).toBe("linux"); expect(plan.customPaths).toEqual(["/var/tmp/José Müller/notes file.txt"]); expect(plan.sensitiveSelections).toEqual([]);
    expect(plan.artifactIds).toContain("lin.logs.journal"); expect(plan.artifactIds).not.toContain("lin.volatile.processes.cmdline");
    // generate package
    await page.getByRole("button", { name: "Generate package" }).click(); await page.getByText("Package ready").waitFor();
    const sha = await page.locator(".copybox").first().innerText(); expect(sha.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(await page.locator(".canvas").innerText()).toMatch(/not a signature/);
    await page.screenshot({ path: join(SHOTS, "07-export.png") }); await axe("export");
    // stale handling: change plan -> export invalidated
    await rail(/^Scope/).click(); await page.locator("#days").fill("3");
    await rail(/^Export/).click();
    await page.getByText("This export is out of date").waitFor(); expect(await page.getByRole("button", { name: /^Download eec-/ }).count()).toBe(0);
  });

  it("switching OS clears stale artifacts; preset replacement shows a preview first", async () => {
    await rail(/^Target/).click();
    await page.getByRole("button", { name: /^Windows/ }).click();
    expect(await page.locator(".summary").innerText()).toMatch(/0 artifacts/); await page.getByText(/Switched to Windows/).waitFor();
    await page.getByRole("button", { name: /^Investigation/ }).click(); // empty selection -> applies directly
    await rail(/^Artifacts/).click(); await page.locator("#a-win\\.baseline\\.system").uncheck();
    await rail(/^Target/).click(); await page.getByRole("button", { name: /^Quick triage/ }).click();
    await page.getByRole("dialog").waitFor(); expect(await page.getByRole("dialog").innerText()).toMatch(/Will add[\s\S]*Will remove/);
    await page.getByRole("button", { name: "Keep my selection" }).click();
    expect(await page.locator(".summary").innerText()).toMatch(/personal data|Personal data/i);
  });

  it("verify: uploads a synthetic collection, shows integrity and completeness separately, exports report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eec-uiv-")); buildSynthRun(dir, { state: "partial", files: [{ name: "a/x.txt", content: "1" }, { name: "b/y.txt", content: "2" }, { name: "c.txt", content: "", outcome: "failed", error: "Permission denied", artifactId: "lin.logs.auth" }] });
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Verify" }).click();
    await page.locator("#verify-files").setInputFiles(readdirSync(dir).map((f) => join(dir, f)));
    await page.locator("#main").getByRole("button", { name: "Verify", exact: true }).click(); await page.getByRole("heading", { name: "Collection report" }).waitFor();
    expect(await page.locator("section[aria-labelledby=rep-title]").innerText()).toMatch(/Integrity verified[\s\S]*Collection partial/);
    expect(await page.locator("section[aria-labelledby=rep-title]").innerText()).toMatch(/Permission denied/);
    await page.screenshot({ path: join(SHOTS, "08-verify-report.png"), fullPage: true }); await axe("verify");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export HTML report" }).click()]);
    expect(readFileSync((await dl.path())!, "utf8")).toContain("Content-Security-Policy");
    await page.getByRole("searchbox", { name: "Filter entries" }).fill("nonexistent-zzz"); expect(await page.locator("tbody tr").count()).toBeGreaterThan(0);
  });

  it("settings: transport profile unknowns stay unknown; background disabled until validated", async () => {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
    await page.screenshot({ path: join(SHOTS, "09-settings.png"), fullPage: true }); await axe("settings");
    expect(await page.locator("#tp-to").inputValue()).toBe(""); expect(await page.locator("#tp-bg").inputValue()).toBe("unknown");
  });

  it("themes and narrow screens render without horizontal overflow; dark theme passes axe", async () => {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Plan" }).click();
    await rail(/^Artifacts/).click();
    for (const [w, h, name] of [[1024, 768, "laptop"], [390, 844, "narrow"]] as const) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(100);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `overflow at ${w}`).toBe(true);
      await page.screenshot({ path: join(SHOTS, `10-${name}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Settings" }).click();
    await page.locator("#theme").selectOption("dark"); await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Plan" }).click(); await rail(/^Artifacts/).click();
    await page.screenshot({ path: join(SHOTS, "11-dark.png") }); await axe("dark artifacts");
  });

  it("made no external network requests and no console errors", () => {
    const origin = new URL(url).origin; const external = requests.filter((r) => !r.startsWith(origin) && !r.startsWith("blob:") && !r.startsWith("data:"));
    expect(external).toEqual([]); expect(consoleErrors).toEqual([]);
  });
});
