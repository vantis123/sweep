/**
 * Batch v7 test — pull a list of IIQ clients from Supabase and run the live
 * v7 pipeline on each. Reports per-bureau dispute counts per client.
 *
 *   SUPABASE_URL=... SUPABASE_KEY=... npx tsx apps/dashboard/test/batch-test-v7.ts
 *
 * Pass NAMES env var (comma-separated) to filter to specific clients.
 */

import { chromium } from "playwright";
import { iiqLogin } from "@sweep/playwright-flows";
import { extractIIQAccounts, listIIQDisputes } from "@sweep/parsers";
import { BUREAU_CONTACTS, ACCOUNT_DISPUTE_REASONS, renderAffidavitHtml, type AffidavitItem } from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";
import { readFile, mkdir } from "node:fs/promises";
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

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";

interface Client {
  name: string;
  monitoringUsername: string;
  monitoringPassword: string;
  ssnLast4: string;
  status: string;
}

async function fetchActiveClients(): Promise<Client[]> {
  const url = `${SUPABASE_URL}/rest/v1/Client?select=name,monitoringUsername,monitoringPassword,ssnLast4,status&monitoringPlatform=eq.identityiq&isActive=eq.true&status=eq.ACTIVE&monitoringUsername=not.is.null&monitoringPassword=not.is.null`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!r.ok) throw new Error(`Supabase fetch failed: ${r.status}`);
  return r.json();
}

async function runOne(client: Client): Promise<{ ok: boolean; counts?: { tu: number; ex: number; eq: number }; error?: string }> {
  await mkdir(SANDBOX_DIR, { recursive: true });
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
  const ctx = { page, context, sandboxDir: SANDBOX_DIR, log: (m: string) => console.log(`       ${m}`), warnings: [] as string[], screenshots: [] as string[] };
  try {
    await iiqLogin(ctx, client.monitoringUsername, client.monitoringPassword, client.ssnLast4);
    await sleep(2500);
    // Dismiss modal
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
    try {
      await page.locator('a:has-text("View Latest Report")').first().click({ timeout: 6000 });
    } catch {
      await page.goto("https://member.identityiq.com/CreditReport.aspx", { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    await sleep(4000);
    const downloadPath = `${SANDBOX_DIR}/iiq-${slug(client.name)}-${Date.now()}.html`;
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 45000 }),
      page.locator('button:has-text("Download this report"), a:has-text("Download this report")').first().click(),
    ]);
    await download.saveAs(downloadPath);

    const html = await readFile(downloadPath, "utf8");
    const extraction = extractIIQAccounts(html);
    const disputes = listIIQDisputes(extraction);
    const counts = {
      tu: disputes.filter((d) => d.bureau === "transunion").length,
      ex: disputes.filter((d) => d.bureau === "experian").length,
      eq: disputes.filter((d) => d.bureau === "equifax").length,
    };

    // Generate letters
    const clientSlug = slug(client.name);
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
        client: { fullName: client.name, address: "", cityStateZip: "", dob: "", ssnLast4: client.ssnLast4 ?? "" },
        bureau: BUREAU_CONTACTS[bureau],
        date: dateStr,
        items,
        personalInfoItems: [],
      });
      const outPath = resolve(outDir, `sweep-v7batch-${clientSlug}-${bureau}-${ts}.pdf`);
      await renderLetterPdf({
        html: htmlContent,
        fcra605bPath: FCRA_605B_PATH,
        breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
        outputPath: outPath,
      });
    }
    return { ok: true, counts };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  console.log(`\n  BATCH v7 TEST\n`);
  const clients = await fetchActiveClients();
  console.log(`  Active IIQ clients with creds: ${clients.length}`);

  const namesFilter = (process.env.NAMES ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  const toTest = namesFilter.length > 0
    ? clients.filter((c) => namesFilter.some((n) => c.name.toLowerCase().includes(n)))
    : clients;

  console.log(`  Will test: ${toTest.length} client(s)`);
  toTest.forEach((c) => console.log(`    - ${c.name}`));
  console.log();

  const results: Array<{ name: string; ok: boolean; counts?: any; error?: string }> = [];
  for (const c of toTest) {
    console.log(`\n  === ${c.name} (${c.monitoringUsername}) ===`);
    const t0 = Date.now();
    const r = await runOne(c);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.ok) {
      console.log(`    ✓ TU=${r.counts!.tu}  EX=${r.counts!.ex}  EQ=${r.counts!.eq}  (${elapsed}s)`);
    } else {
      console.log(`    ✗ ${r.error}  (${elapsed}s)`);
    }
    results.push({ name: c.name, ...r });
  }

  console.log(`\n\n  ╔════════════════════════════════════════╗`);
  console.log(`  ║  BATCH SUMMARY                         ║`);
  console.log(`  ╚════════════════════════════════════════╝`);
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.name.padEnd(30)} TU=${r.counts.tu}  EX=${r.counts.ex}  EQ=${r.counts.eq}`);
    } else {
      console.log(`  ✗ ${r.name.padEnd(30)} ${r.error?.slice(0, 60)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
