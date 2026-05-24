/**
 * Live IIQ pull + v7 extraction + 3 dispute letters.
 * Use to validate v7 against a second real client.
 *
 *   SWEEP_USERNAME=... SWEEP_PASSWORD=... LAST4=... CLIENT="Name" \
 *     npx tsx apps/dashboard/test/live-test-v7.ts
 */

import { chromium } from "playwright";
import { iiqLogin } from "@sweep/playwright-flows";
import { extractIIQAccounts, listIIQDisputes } from "@sweep/parsers";
import { BUREAU_CONTACTS, ACCOUNT_DISPUTE_REASONS, renderAffidavitHtml, type AffidavitItem } from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");
const SANDBOX_DIR = resolve(homedir(), ".sweep", "sandbox");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";

async function main() {
  const username = process.env.SWEEP_USERNAME!;
  const password = process.env.SWEEP_PASSWORD!;
  const last4 = process.env.LAST4!;
  const clientName = process.env.CLIENT || "Test Client";
  if (!username || !password) { console.error("SWEEP_USERNAME/SWEEP_PASSWORD required"); process.exit(1); }

  await mkdir(SANDBOX_DIR, { recursive: true });
  console.log(`\n  Live v7 test — ${clientName}`);
  console.log(`  user: ${username}`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1920,1200", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  const ctx = { page, context, sandboxDir: SANDBOX_DIR, log: (m: string) => console.log(`     ${m}`), warnings: [] as string[], screenshots: [] as string[] };

  try {
    console.log(`\n  [1/4] Login`);
    await iiqLogin(ctx, username, password, last4);

    console.log(`\n  [2/4] Dismiss modal + View Latest Report + Download this report`);
    await sleep(2500);
    // Dismiss "Credit & Debt" upsell modal if present
    for (let i = 0; i < 6; i++) {
      const target = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
        const el = all.find((e) => {
          const raw = (e.textContent ?? "").trim();
          if (!(raw.toLowerCase() === "no thanks" || raw.toLowerCase() === "no thanks →")) return false;
          if (raw.length > 30) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!target) break;
      await page.mouse.click(target.x, target.y);
      await sleep(900);
    }
    await sleep(1500);
    // Click View Latest Report
    try {
      await page.locator('a:has-text("View Latest Report")').first().click({ timeout: 6000 });
    } catch {
      await page.goto("https://member.identityiq.com/CreditReport.aspx", { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    await sleep(4000);
    // Click Download this report
    const downloadPath = `${SANDBOX_DIR}/iiq-credit-report-${Date.now()}.html`;
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 45000 }),
        page.locator('button:has-text("Download this report"), a:has-text("Download this report")').first().click(),
      ]);
      await download.saveAs(downloadPath);
      console.log(`     downloaded → ${downloadPath}`);
    } catch (e) {
      console.error(`     download failed: ${(e as Error).message}`);
      await browser.close();
      process.exit(1);
    }

    console.log(`\n  [3/4] v7 extract`);
    const html = await readFile(downloadPath, "utf8");
    const extraction = extractIIQAccounts(html);
    const disputes = listIIQDisputes(extraction);
    const counts = {
      transunion: disputes.filter((d) => d.bureau === "transunion").length,
      experian: disputes.filter((d) => d.bureau === "experian").length,
      equifax: disputes.filter((d) => d.bureau === "equifax").length,
    };
    console.log(`     Reference #:  ${extraction.referenceNumber}`);
    console.log(`     Report Date:  ${extraction.reportDate}`);
    console.log(`     Accounts:     ${extraction.accounts.length}`);
    console.log(`     Disputes:     TU=${counts.transunion}  EX=${counts.experian}  EQ=${counts.equifax}`);
    if (extraction.accounts.length === 0) {
      console.log(`\n  ✗ No accounts extracted. Account doesn't have an active 3-bureau report.\n`);
      await browser.close();
      process.exit(2);
    }
    console.log(`\n     Per-bureau dispute targets:`);
    for (const bureau of ["transunion", "experian", "equifax"] as const) {
      const items = disputes.filter((d) => d.bureau === bureau);
      console.log(`       ${bureau.toUpperCase()}:`);
      items.forEach((d) => console.log(`         ${d.category.padEnd(11)} ${d.creditor.slice(0, 50).padEnd(50)} ${d.detail}`));
    }

    console.log(`\n  [4/4] Generate 3 dispute letter PDFs`);
    const clientSlug = slug(clientName);
    const outDir = resolve(LETTERS_DIR, clientSlug);
    await mkdir(outDir, { recursive: true });
    const ts = Date.now();
    const dateStr = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    for (const bureau of ["transunion", "experian", "equifax"] as const) {
      const items: AffidavitItem[] = disputes
        .filter((d) => d.bureau === bureau)
        .map((d) => ({
          creditor: d.creditor,
          detail: d.detail,
          reasonText: ACCOUNT_DISPUTE_REASONS.find((r) => r.id === "not-mine")!.text,
        }));
      if (items.length === 0) continue;
      const htmlContent = await renderAffidavitHtml({
        client: { fullName: clientName, address: "", cityStateZip: "", dob: "", ssnLast4: "" },
        bureau: BUREAU_CONTACTS[bureau],
        date: dateStr,
        items,
        personalInfoItems: [],
      });
      const fileName = `sweep-v7live-${clientSlug}-${bureau}-${ts}.pdf`;
      const outPath = resolve(outDir, fileName);
      await renderLetterPdf({
        html: htmlContent,
        fcra605bPath: FCRA_605B_PATH,
        breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
        outputPath: outPath,
      });
      console.log(`     ✓ ${bureau.padEnd(11)} ${items.length} items  ${(statSync(outPath).size / 1024).toFixed(1)} KB → ${outPath}`);
    }
    console.log(`\n  ✓ Live v7 test complete.\n`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
