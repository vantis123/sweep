/**
 * Diagnose a single client's capture flow with full per-step logging:
 * URL, page text length, screenshot at each milestone.
 *
 *   SUPABASE_URL=... SUPABASE_KEY=... NAME='hunter' npx tsx apps/dashboard/test/diagnose-capture.ts
 */

import { chromium } from "playwright";
import { iiqLogin } from "@sweep/playwright-flows";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = resolve(homedir(), ".sweep", "stepper");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  await mkdir(SANDBOX_DIR, { recursive: true });
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_KEY = process.env.SUPABASE_KEY!;
  const nameFilter = (process.env.NAME ?? "").toLowerCase();

  const r = await fetch(`${SUPABASE_URL}/rest/v1/Client?select=name,monitoringUsername,monitoringPassword,ssnLast4&monitoringPlatform=eq.identityiq&isActive=eq.true&status=eq.ACTIVE&monitoringUsername=not.is.null`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  const clients: any[] = await r.json();
  const c = clients.find((x) => x.name.toLowerCase().includes(nameFilter));
  if (!c) { console.error(`No client matching '${nameFilter}'`); process.exit(1); }
  console.log(`\n  DIAGNOSING ${c.name} (${c.monitoringUsername})\n`);

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

  const snap = async (label: string) => {
    const path = resolve(SANDBOX_DIR, `diag-${nameFilter}-${label}-${Date.now()}.png`);
    try {
      await page.screenshot({ path, fullPage: false, timeout: 5000 });
      const url = page.url();
      const textLen = (await page.evaluate(() => document.body?.innerText.length || 0).catch(() => 0));
      console.log(`  📸 ${label.padEnd(20)}  url=${url}  text=${textLen} chars  → ${path}`);
    } catch (e) {
      console.log(`  ❌ ${label}: ${(e as Error).message}`);
    }
  };

  try {
    console.log(`  [1] Login flow (iiqLogin)`);
    await iiqLogin(ctx, c.monitoringUsername, c.monitoringPassword, c.ssnLast4);
    await snap("01-after-login");

    console.log(`\n  [2] Looking for modal / sidebar / page content`);
    await sleep(2500);
    const pageScan = await page.evaluate(() => ({
      url: window.location.href,
      hasNoThanks: !!Array.from(document.querySelectorAll("*")).find((e) => (e.textContent ?? "").trim().toLowerCase() === "no thanks"),
      hasViewLatestReport: !!document.querySelector('a:has-text("View Latest Report")'),  // not selectors but heuristic
      anchorTexts: Array.from(document.querySelectorAll("a")).slice(0, 20).map((a) => a.textContent?.trim().slice(0, 40) ?? ""),
      buttonTexts: Array.from(document.querySelectorAll("button")).slice(0, 15).map((b) => b.textContent?.trim().slice(0, 40) ?? ""),
    }));
    console.log(`     URL: ${pageScan.url}`);
    console.log(`     Has "No Thanks" element: ${pageScan.hasNoThanks}`);
    console.log(`     First 10 anchor texts:`);
    pageScan.anchorTexts.slice(0, 10).forEach((t) => console.log(`       - ${t}`));
    console.log(`     First 5 button texts:`);
    pageScan.buttonTexts.slice(0, 5).forEach((t) => console.log(`       - ${t}`));
    await snap("02-page-scanned");

    console.log(`\n  [3] Dismiss modal if present`);
    for (let i = 0; i < 4; i++) {
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
      console.log(`     clicked No Thanks at (${Math.round(target.x)},${Math.round(target.y)})`);
      await sleep(900);
    }
    await snap("03-after-modal");

    console.log(`\n  [4] Try View Latest Report click`);
    try {
      await page.locator('a:has-text("View Latest Report")').first().click({ timeout: 8000 });
      console.log(`     ✓ clicked View Latest Report`);
    } catch (e) {
      console.log(`     ✗ View Latest Report not clickable: ${(e as Error).message.split("\n")[0]}`);
      console.log(`     Falling back to direct nav`);
      await page.goto("https://member.identityiq.com/CreditReport.aspx", { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log(`     direct nav failed: ${e.message}`));
    }
    await sleep(4000);
    await snap("04-after-nav-to-report");

    console.log(`\n  [5] Check for Download this report button`);
    const downloadCheck = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      const matches = all.filter((e) => (e.textContent ?? "").trim().toLowerCase().includes("download this report"));
      return matches.slice(0, 5).map((m) => ({ tag: m.tagName, text: m.textContent?.trim().slice(0, 60) ?? "" }));
    });
    console.log(`     "Download this report" matches in DOM: ${downloadCheck.length}`);
    downloadCheck.forEach((m) => console.log(`       ${m.tag}: "${m.text}"`));

    // Detect Purchase Report state
    const hasPurchase = await page.evaluate(() => (document.body?.innerText ?? "").toLowerCase().includes("purchase report"));
    const hasThreeBureauHeader = await page.evaluate(() => (document.body?.innerText ?? "").toLowerCase().includes("three bureau credit report"));
    console.log(`     Page has "Purchase Report": ${hasPurchase}`);
    console.log(`     Page has "Three Bureau Credit Report": ${hasThreeBureauHeader}`);
    await snap("05-report-page");

    console.log(`\n  Browser stays open 30s for you to look at the state.`);
    await sleep(30000);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
