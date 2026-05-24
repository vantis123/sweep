/**
 * Sweep — IIQ stepper.
 *
 * Walks the IIQ flow step-by-step with a screenshot after each action so we
 * can SEE what each step actually does before encoding any of it into the
 * production capture flow. Bank's proven iiqLogin handles login + security
 * challenge. This stepper only iterates on what happens AFTER that.
 *
 *   PLATFORM=iiq SWEEP_USERNAME=... SWEEP_PASSWORD=... LAST4=... \
 *     npx tsx apps/dashboard/test/iiq-stepper.ts
 *
 * Output:
 *   ~/.sweep/stepper/step-NN-{label}-{ts}.png — screenshots, one per step
 *   ~/.sweep/stepper/report-{ts}.pdf          — the downloaded report (if step 5 works)
 *
 * The browser stays open at the end for 90 seconds so we can poke around.
 */

import { chromium, type Page } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

import { iiqLogin } from "@sweep/playwright-flows";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STEPS_DIR = resolve(homedir(), ".sweep", "stepper");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function snap(page: Page, label: string): Promise<string | null> {
  const path = resolve(STEPS_DIR, `${label}-${Date.now()}.png`);
  try {
    // viewport-only screenshot — avoids the fullPage fonts-loading wait that
    // kept timing out at 30s on IIQ.
    await page.screenshot({ path, fullPage: false, timeout: 8000 });
    console.log(`     📸 ${path}`);
    return path;
  } catch (e) {
    console.log(`     ❌ screenshot ${label} failed: ${(e as Error).message}`);
    return null;
  }
}

async function step(num: string, label: string) {
  console.log(`\n  ── ${num}  ${label}`);
}

async function main() {
  const username = process.env.SWEEP_USERNAME;
  const password = process.env.SWEEP_PASSWORD;
  const last4 = process.env.LAST4;

  if (!username || !password) {
    console.error("\n  Missing SWEEP_USERNAME / SWEEP_PASSWORD\n");
    process.exit(1);
  }

  await mkdir(STEPS_DIR, { recursive: true });

  console.log(`\n  IIQ stepper`);
  console.log(`  user:   ${username}`);
  console.log(`  last4:  ${last4 ? `${last4.slice(0, 2)}**` : "(none)"}`);
  console.log(`  steps:  ${STEPS_DIR}`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--window-size=1920,1200",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    acceptDownloads: true,
  });

  // Hide navigator.webdriver and a few other automation tells before any
  // page script runs. Sites like IIQ short-circuit content rendering when
  // they detect headless / Playwright fingerprints.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  const ctx = {
    page,
    context,
    sandboxDir: STEPS_DIR,
    log: (msg: string) => console.log(`     ${msg}`),
    warnings: [] as string[],
    screenshots: [] as string[],
  };

  try {
    // STEP 1+2: login + security challenge — use Bank's proven iiqLogin
    await step("01", "Bank's iiqLogin (login + security challenge)");
    await iiqLogin(ctx, username, password, last4);
    console.log(`     URL after login: ${page.url()}`);
    await snap(page, "01-after-login");

    // Some IIQ sessions land on /Dashboard.aspx with a "what's new" banner
    // covering the sidebar — give it a beat to settle.
    await sleep(2500);

    // STEP 1.5: Dismiss the upsell modal carousel.
    // Strategy: a) try Escape key first (universal modal-close),
    //           b) then find No Thanks via DOM and click via Playwright (real
    //              user event, not synthetic — IIQ ignores el.click() because
    //              React only listens to trusted events).
    await step("01.5", "Dismiss any upsell modal (Escape + Playwright clicks)");
    for (let i = 0; i < 6; i++) {
      // First try Escape
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(300);

      // Find a visible "No Thanks" element. We need the BOUNDING BOX so we
      // can let Playwright dispatch a real mouse click (synthetic .click()
      // got ignored by React).
      const target = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
        const el = all.find((e) => {
          const raw = (e.textContent ?? "").trim();
          const lower = raw.toLowerCase();
          if (!(lower === "no thanks" || lower === "no thanks →" || lower.startsWith("no thanks"))) return false;
          if (raw.length > 30) return false;
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          return true;
        });
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          tag: el.tagName,
          cls: el.className?.toString().slice(0, 40),
          text: (el.textContent ?? "").slice(0, 40),
        };
      });

      if (!target) {
        if (i === 0) console.log(`     no modal visible — skipping`);
        else console.log(`     modal dismissed after ${i} click(s)`);
        break;
      }

      // Playwright mouse click — generates real input events React listens to
      await page.mouse.click(target.x, target.y);
      console.log(`     pass ${i + 1}: clicked ${target.tag} "${target.text}" at (${Math.round(target.x)},${Math.round(target.y)})`);
      await sleep(1100);
    }
    await snap(page, "01.5-after-dismiss");

    // STEP 02: Navigate to the credit report. Primary path: click the
    // "View Latest Report" link visible on the dashboard (goes straight to
    // /CreditReport.aspx). Fallback: hover sidebar Reports & Scores → click
    // Credit Reports submenu. Either gets us to the same page.
    await step("02", "Navigate to Credit Report");

    let navigated = false;

    // Primary: View Latest Report
    try {
      const viewLatest = page.locator('a:has-text("View Latest Report")').first();
      await viewLatest.waitFor({ state: "visible", timeout: 6000 });
      await viewLatest.click();
      console.log(`     clicked 'View Latest Report'`);
      navigated = true;
    } catch {
      console.log(`     'View Latest Report' not visible, trying sidebar hover`);
    }

    // Fallback: sidebar hover + Credit Reports submenu
    if (!navigated) {
      const hoverTarget = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
        const el = all.find((e) => {
          const raw = (e.textContent ?? "").trim();
          if (raw !== "Reports & Scores") return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (hoverTarget) {
        await page.mouse.move(hoverTarget.x, hoverTarget.y);
        console.log(`     hovered sidebar at (${Math.round(hoverTarget.x)},${Math.round(hoverTarget.y)})`);
        await sleep(1500);
        try {
          await page.locator('a:has-text("Credit Reports")').first().click({ timeout: 5000 });
          console.log(`     clicked Credit Reports submenu`);
          navigated = true;
        } catch (e) {
          console.log(`     could not click Credit Reports: ${(e as Error).message}`);
        }
      } else {
        console.log(`     sidebar 'Reports & Scores' not findable in DOM`);
      }
    }

    if (!navigated) {
      console.log(`     last resort: navigating to /CreditReport.aspx directly`);
      await page.goto("https://member.identityiq.com/CreditReport.aspx", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => {});
    }

    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {}
    await sleep(4000);
    console.log(`     URL after nav: ${page.url()}`);
    await snap(page, "02-credit-reports-page");

    // STEP 03: Wait for the credit report page to fully render. IIQ's
    // /CreditReport.aspx is slow — the Download button doesn't appear until
    // the report data is fetched and laid out (~10-20s after navigation).
    await step("03", "Wait for credit report page to fully render");
    const ready = await page.evaluate(async () => {
      // Wait up to 30s for the "Three Bureau Credit Report" marker text
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const t = (document.body?.innerText ?? "").toLowerCase();
        if (t.includes("three bureau credit report") || t.includes("download this report")) {
          return { ready: true, ms: Date.now() - start };
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { ready: false, ms: 30000 };
    });
    console.log(`     report ready: ${ready.ready}  (after ${ready.ms}ms)`);

    // Diagnostic: list anything with "Download" in the text
    const downloadCandidates = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("*"))
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent ?? "").trim().slice(0, 50),
          visible: (el as HTMLElement).offsetParent !== null,
        }))
        .filter((x) => x.visible && x.text.toLowerCase().includes("download") && x.text.length < 80)
        .slice(0, 15);
    });
    console.log(`     visible elements containing "Download":`);
    downloadCandidates.forEach((c) => console.log(`       - ${c.tag} "${c.text}"`));

    // STEP 04: click Download — try several selector variants
    await step("04", "Click 'Download this report' and capture download");
    const downloadPath = resolve(STEPS_DIR, `report-${Date.now()}.pdf`);
    let downloaded = false;
    for (const sel of [
      'button:has-text("Download this report")',
      'a:has-text("Download this report")',
      'button:has-text("Download Report")',
      'a:has-text("Download Report")',
      ':has-text("Download this report") >> visible=true',
      'button:has-text("Download")',
      'a:has-text("Download")',
    ]) {
      try {
        const link = page.locator(sel).first();
        await link.waitFor({ state: "visible", timeout: 6000 });
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 60000 }),
          link.click(),
        ]);
        await download.saveAs(downloadPath);
        console.log(`     ✓ Downloaded via ${sel}`);
        const { statSync } = await import("node:fs");
        console.log(`     → ${downloadPath}  (${(statSync(downloadPath).size / 1024).toFixed(1)} KB)`);
        downloaded = true;
        break;
      } catch {}
    }

    if (!downloaded) {
      console.log(`     ✗ no download triggered — trying DOM click as fallback`);
      try {
        const target = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
          const el = all.find((e) => {
            const raw = (e.textContent ?? "").trim();
            if (raw.toLowerCase() !== "download this report") return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (target) {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 60000 }),
            page.mouse.click(target.x, target.y),
          ]);
          await download.saveAs(downloadPath);
          console.log(`     ✓ Downloaded via DOM mouse click at (${Math.round(target.x)},${Math.round(target.y)})`);
          downloaded = true;
        } else {
          console.log(`     no DOM element with text "Download this report" found`);
        }
      } catch (e) {
        console.log(`     DOM fallback also failed: ${(e as Error).message}`);
      }
    }

    if (!downloaded) await snap(page, "04-download-failed");
    await snap(page, "04-final");
    console.log(`\n  Done — closing browser.`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
