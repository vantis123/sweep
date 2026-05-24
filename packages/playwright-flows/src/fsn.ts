/**
 * FSN (MyFreeScoreNow) capture flow.
 *
 * Strategy:
 *   1. Login — try new site (app.*) first, fall back to legacy (member.*) if
 *      we land on an enrollment funnel.
 *   2. Navigate to credit report — try text-based locators ("Credit Report"),
 *      then a list of known direct URLs (smart-3b, /credit-report, etc.).
 *   3. Capture — print-popup if available, else download, else per-tradeline
 *      expand-capture-collapse loop.
 */

import type { Page } from "playwright";
import { readFile } from "node:fs/promises";
import { sleep, scrollPass, findVisible, snap } from "./util.ts";
import type { CaptureSource, FlowContext } from "./types.ts";

async function extractPdfText(path: string): Promise<string> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const buf = await readFile(path);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const result = await parser.getText();
    await parser.destroy();
    if (Array.isArray(result.pages)) {
      return result.pages
        .map((p: { text?: string }) => p.text ?? "")
        .filter(Boolean)
        .join("\n\n");
    }
    return (result as { text?: string }).text ?? "";
  } catch {
    return "";
  }
}

interface FSNSite {
  label: "new" | "legacy";
  loginUrl: string;
}

// Legacy site first — every real Skool client is on member.myfreescorenow.com.
// The "new" app.myfreescorenow.com is the marketing/enrollment site that
// always punts existing members to a "you don't have an active subscription"
// dead-end. Trying it first wastes ~15-25s on every login.
const FSN_SITES: FSNSite[] = [
  { label: "legacy", loginUrl: "https://member.myfreescorenow.com/login" },
  { label: "new", loginUrl: "https://app.myfreescorenow.com/login" },
];

const REPORT_URLS = [
  "https://member.myfreescorenow.com/member/credit-report/smart-3b/",
  "https://member.myfreescorenow.com/member/credit-report/smart-3b",
  "https://app.myfreescorenow.com/credit-report",
  "https://app.myfreescorenow.com/credit_report",
  "https://app.myfreescorenow.com/report",
  "https://app.myfreescorenow.com/3b-report",
  "https://member.myfreescorenow.com/credit-report",
  "https://member.myfreescorenow.com/3b-report",
  "https://member.myfreescorenow.com/Reports",
  "https://member.myfreescorenow.com/Members/Reports",
];

export async function fsnLogin(
  ctx: FlowContext,
  username: string,
  password: string
): Promise<FSNSite> {
  let lastErr: Error | null = null;
  for (const site of FSN_SITES) {
    try {
      const ok = await fsnLoginSite(ctx, username, password, site);
      if (ok) {
        ctx.log(`  -> Logged in via ${site.label} site`);
        return site;
      }
    } catch (err) {
      lastErr = err as Error;
      ctx.log(`  -> ${site.label} login threw: ${(err as Error).message}`);
    }
  }
  throw lastErr ?? new Error("FSN login failed on all known sites");
}

async function fsnLoginSite(
  ctx: FlowContext,
  username: string,
  password: string,
  site: FSNSite
): Promise<boolean> {
  ctx.log(`  -> Trying ${site.label}: ${site.loginUrl}`);
  await ctx.page.goto(site.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(3000);

  const userField = await findVisible(ctx.page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="userName"]',
    "#email",
    "#username",
    'input[placeholder*="email" i]',
    'input[autocomplete="username"]',
  ]);
  const passField = await findVisible(ctx.page, [
    'input[type="password"]',
    'input[name="password"]',
    "#password",
  ]);

  if (!userField || !passField) {
    throw new Error(
      `Login fields not found (user=${!!userField}, pass=${!!passField})`
    );
  }

  await ctx.page.fill(userField, username);
  await sleep(400);
  await ctx.page.fill(passField, password);
  await sleep(700);

  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'a:has-text("Sign In")',
  ];
  const submit = await findVisible(ctx.page, submitSelectors);
  if (submit) {
    await ctx.page.click(submit);
  } else {
    await ctx.page.press(passField, "Enter");
  }

  try {
    await ctx.page.waitForNavigation({ waitUntil: "networkidle", timeout: 25000 });
  } catch {
    await sleep(7000);
  }

  const finalUrl = ctx.page.url();
  ctx.log(`  -> Post-login URL: ${finalUrl}`);

  if (
    /\/enroll\//i.test(finalUrl) ||
    /\/login\b/i.test(finalUrl) ||
    /\/signup\b/i.test(finalUrl)
  ) {
    ctx.log(
      `  -> ${site.label} dropped to ${finalUrl} — not a real dashboard, will try next site`
    );
    return false;
  }
  return true;
}

export async function fsnNavigateToReport(
  ctx: FlowContext
): Promise<{ url: string; source: CaptureSource } | null> {
  ctx.log("  -> Looking for report link in nav");

  // New MFSN layout: top nav has a "Reports ▾" dropdown. Try BOTH hover and
  // click since different sites use either pattern, then click "3B Report &
  // Scores" inside the opened menu. Selectors are scoped to nav so we don't
  // hit the dashboard tile heading which has identical text.
  for (const reportsSel of [
    'nav a:has-text("Reports")',
    'nav button:has-text("Reports")',
    'header a:has-text("Reports")',
    'header button:has-text("Reports")',
    'a:has-text("Reports")',
  ]) {
    try {
      const trigger = ctx.page.locator(reportsSel).first();
      await trigger.waitFor({ state: "visible", timeout: 2000 });
      // Hover first (most dropdowns) — if menu doesn't open, also try click.
      await trigger.hover();
      await sleep(600);
      let clickedSubmenu = false;
      for (const itemSel of [
        'nav a:has-text("3B Report & Scores")',
        'header a:has-text("3B Report & Scores")',
        '[role="menu"] a:has-text("3B Report & Scores")',
        '[role="menuitem"]:has-text("3B Report & Scores")',
        '.dropdown-menu a:has-text("3B Report & Scores")',
      ]) {
        try {
          const item = ctx.page.locator(itemSel).first();
          await item.waitFor({ state: "visible", timeout: 1500 });
          await item.click();
          ctx.log(`  -> Hover→clicked submenu via ${itemSel}`);
          clickedSubmenu = true;
          break;
        } catch {}
      }
      if (!clickedSubmenu) {
        // Hover didn't open it — try a real click on the trigger.
        await trigger.click();
        await sleep(900);
        for (const itemSel of [
          'nav a:has-text("3B Report & Scores")',
          'header a:has-text("3B Report & Scores")',
          '[role="menu"] a:has-text("3B Report & Scores")',
          '[role="menuitem"]:has-text("3B Report & Scores")',
          '.dropdown-menu a:has-text("3B Report & Scores")',
          'a:has-text("3B Report & Scores"):visible',
        ]) {
          try {
            const item = ctx.page.locator(itemSel).first();
            await item.waitFor({ state: "visible", timeout: 1500 });
            // Submenu link may have target="_blank" → click might open a new
            // tab. Race the click against a context page event so we capture
            // either path.
            const newPagePromise = ctx.context
              .waitForEvent("page", { timeout: 3000 })
              .catch(() => null);
            await item.click();
            const newPage = await newPagePromise;
            if (newPage) {
              ctx.log(`  -> Submenu opened new tab — switching to it`);
              await newPage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
              ctx.page = newPage;
            }
            ctx.log(`  -> Click→clicked submenu via ${itemSel}`);
            clickedSubmenu = true;
            break;
          } catch {}
        }
      }
      if (clickedSubmenu) {
        await sleep(6000);
        return { url: ctx.page.url(), source: classifyUrl(ctx.page.url()) };
      }
    } catch {}
  }

  // Dashboard "3B Report & Scores" tile has a small "View Last Report" link
  // that goes directly to the latest 3B report. Try multiple element shapes
  // since the link styling varies (sometimes <a>, sometimes <span>, sometimes
  // wrapped with " 1 day ago" trailing).
  for (const sel of [
    'text="View Last Report"',
    'a:has-text("View Last Report")',
    'button:has-text("View Last Report")',
    '*:has-text("View Last Report"):visible',
  ]) {
    try {
      const el = ctx.page.locator(sel).first();
      await el.waitFor({ state: "visible", timeout: 1500 });
      await el.click();
      ctx.log(`  -> Clicked "View Last Report" via ${sel}`);
      await sleep(6000);
      return { url: ctx.page.url(), source: classifyUrl(ctx.page.url()) };
    } catch {}
  }

  for (const text of ["Credit Report", "3B Report", "View Full Report", "View Report"]) {
    try {
      const el = ctx.page.getByText(text, { exact: true }).first();
      if (await el.isVisible({ timeout: 1500 })) {
        ctx.log(`  -> Clicking text: "${text}"`);
        await el.click();
        await sleep(6000);
        return { url: ctx.page.url(), source: classifyUrl(ctx.page.url()) };
      }
    } catch {}
  }

  for (const url of REPORT_URLS) {
    try {
      ctx.log(`  -> Trying direct URL: ${url}`);
      const resp = await ctx.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      if (resp && resp.status() < 400) {
        await sleep(4000);
        const finalUrl = ctx.page.url();
        if (!finalUrl.endsWith("/dashboard") && !finalUrl.endsWith("/login")) {
          return { url: finalUrl, source: classifyUrl(finalUrl) };
        }
      }
    } catch {}
  }
  return null;
}

/**
 * The new MFSN site shows a "Quick Tour" modal on the credit-report page that
 * intercepts scroll and click events. It has a "Don't Show Again" button and
 * a close X. We click whatever's present, retrying a few times because the
 * modal can re-render after the page settles.
 */
async function dismissFsnQuickTour(ctx: FlowContext): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await ctx.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
      // First preference: "Don't Show Again" — kills the modal for the session
      const dontShow = all.find((el) => {
        const t = (el.textContent ?? "").trim().toLowerCase();
        if (!(t === "don't show again" || t === "don’t show again" || t === "dont show again")) return false;
        if ((el.textContent ?? "").length > 30) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (dontShow) {
        dontShow.scrollIntoView({ block: "center" });
        const r = dontShow.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: "Don't Show Again" };
      }
      // Fallback: any X close button on a "Quick Tour" container
      const tourHeader = all.find((el) => {
        const t = (el.textContent ?? "").trim();
        return /^Quick Tour$/i.test(t);
      });
      if (tourHeader) {
        let modal: Element | null = tourHeader;
        for (let depth = 0; depth < 6 && modal; depth++) {
          const closeBtn = modal.querySelector('button[aria-label*="close" i], button.close, [data-dismiss="modal"]') as HTMLElement | null;
          if (closeBtn) {
            const r = closeBtn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: "modal close X" };
            }
          }
          modal = modal.parentElement;
        }
      }
      return null;
    });
    if (!clicked) {
      if (attempt === 0) ctx.log("  -> No Quick Tour modal detected");
      return;
    }
    await ctx.page.mouse.click(clicked.x, clicked.y);
    ctx.log(`  -> Dismissed Quick Tour via "${clicked.label}" (${Math.round(clicked.x)},${Math.round(clicked.y)})`);
    await sleep(800);
  }
}

function classifyUrl(url: string): CaptureSource {
  if (/member\.myfreescorenow\.com\/member\/credit-report\/smart-3b/i.test(url)) {
    return "fsn-legacy-3b";
  }
  if (/member\.myfreescorenow\.com\/credit-report/i.test(url)) {
    return "fsn-legacy-equifax";
  }
  return "fsn-new";
}

export async function fsnCaptureReport(
  ctx: FlowContext
): Promise<{ text: string; source: CaptureSource; pdfPath?: string }> {
  await sleep(4000);
  await snap(ctx, ctx.page, "fsn-dashboard");

  const nav = await fsnNavigateToReport(ctx);
  if (!nav) {
    ctx.warnings.push("Could not navigate to a credit-report page; capturing dashboard");
  }

  // Dismiss FSN's "Quick Tour" modal — same kind of blocker as IIQ's "No Thanks"
  // carousel. Without this, scroll/click events hit the overlay instead of the
  // report content underneath.
  await dismissFsnQuickTour(ctx);

  // The 3B report page defaults to a new layout that has no per-account
  // expanders. There's a "Switch to Classic View" toggle that flips back to
  // the legacy expandable list — that's the layout parseFSN was built for.
  let switchedToClassic = false;
  for (const sel of [
    'button:has-text("Switch to Classic View")',
    'a:has-text("Switch to Classic View")',
    'text="Switch to Classic View"',
  ]) {
    try {
      const el = ctx.page.locator(sel).first();
      await el.waitFor({ state: "visible", timeout: 2000 });
      await el.click();
      ctx.log(`  -> Switched to Classic View via ${sel}`);
      await sleep(1500);
      switchedToClassic = true;
      break;
    } catch {}
  }

  // Fast path for the Classic View: the full 3B report is server-rendered in
  // a CSS Grid layout — no lazy loading, no expanders to click. Skip the
  // scroll-trigger + print-button + per-tradeline loop entirely. parseFSN3B
  // picks up the HTML directly via cheerio.
  if (switchedToClassic) {
    await snap(ctx, ctx.page, "fsn-credit-report");
    const html = await ctx.page.content();
    return { text: html, source: "fsn-legacy-3b" };
  }

  ctx.log("  -> Scrolling to trigger lazy content");
  await scrollPass(ctx.page, 20);
  await sleep(2000);
  await snap(ctx, ctx.page, "fsn-credit-report");

  // Try the print-button strategy first (fastest, gets a real PDF)
  const printResult = await tryPrintFlow(ctx);
  if (printResult.captured && printResult.text.length >= 200) {
    ctx.log(`  -> PRINT CAPTURED via ${printResult.source} (${printResult.text.length} chars)`);
    return {
      text: printResult.text,
      source: printResult.source,
      pdfPath: printResult.pdfPath,
    };
  }
  if (printResult.captured) {
    ctx.log(`  -> Print path returned thin text (${printResult.text.length} chars) — falling back to tradeline loop`);
  } else {
    ctx.log(`  -> Print path no-op (${printResult.reason}) — falling back`);
  }

  // Fallback: per-tradeline expand-capture-collapse loop. Newer 3B layout
  // labels expanders "View details" (lowercase d); older one used "See Details".
  // Match either.
  const detailLocator = ctx.page.locator(
    'text=/^(View [Dd]etails|See [Dd]etails)$/i',
  );
  const seeDetailsCount = await detailLocator.count();
  ctx.log(`  -> Detail-expander elements: ${seeDetailsCount}`);

  if (seeDetailsCount === 0) {
    // New 3B Classic View has no per-tradeline expanders — the full report is
    // rendered in a CSS Grid. Return raw HTML so parseFSN3B can extract the
    // per-bureau columns directly.
    const html = await ctx.page.content();
    return { text: html, source: nav?.source ?? "fsn-new" };
  }

  ctx.log(`  -> Per-tradeline capture loop`);
  const segments: string[] = [];
  let captured = 0;
  let failed = 0;

  for (let i = 0; i < seeDetailsCount; i++) {
    try {
      const el = detailLocator.nth(i);
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      await sleep(150);
      await el.click({ timeout: 3000 });
      await sleep(400);

      const segment = await ctx.page.evaluate(() => {
        const seeLessEls = Array.from(document.querySelectorAll("*")).filter((el) => {
          const t = (el.textContent || "").trim();
          return /(See Less|Hide [Dd]etails|Less [Dd]etails)\s*$/.test(t) && el.children.length < 5;
        });
        if (seeLessEls.length === 0) return null;
        const seeLessEl = seeLessEls[seeLessEls.length - 1];
        if (!seeLessEl) return null;
        let container: Element | null = seeLessEl;
        for (let depth = 0; depth < 12 && container; depth++) {
          if (container.textContent && /Account Name/i.test(container.textContent)) break;
          container = container.parentElement;
        }
        if (!container) return null;
        return (container as HTMLElement).innerText || container.textContent || "";
      });

      if (segment && segment.length > 200) {
        segments.push(`\n=== Tradeline ${i + 1} ===\n${segment}\n`);
        captured++;
      }

      if ((i + 1) % 10 === 0) {
        ctx.log(`     ... ${i + 1}/${seeDetailsCount} processed (${captured} ok, ${failed} failed)`);
      }
    } catch (e) {
      failed++;
    }
  }

  ctx.log(`  -> Tradeline capture: ${captured} ok / ${failed} failed / ${seeDetailsCount} total`);

  const baselineText = await ctx.page.evaluate(() => document.body?.innerText || "");
  const fullText = baselineText + "\n\n=== EXPANDED TRADELINES ===\n" + segments.join("\n");

  return { text: fullText, source: "fsn-tradeline-loop" };
}

interface PrintResult {
  captured: boolean;
  source: CaptureSource;
  text: string;
  pdfPath?: string;
  reason?: string;
}

async function tryPrintFlow(ctx: FlowContext): Promise<PrintResult> {
  const page = ctx.page;
  const context = ctx.context;
  let popupPage: Page | null = null;
  let downloadPath: string | null = null;
  let printCalled = false;

  await page.evaluate(() => {
    // @ts-ignore
    window.__printIntercepted = false;
    const orig = window.print;
    window.print = function () {
      // @ts-ignore
      window.__printIntercepted = true;
    };
  });

  const popupPromise = context
    .waitForEvent("page", { timeout: 8000 })
    .then((p) => {
      popupPage = p;
      return p;
    })
    .catch(() => null);
  const downloadPromise = page
    .waitForEvent("download", { timeout: 8000 })
    .then(async (d) => {
      const fileName = `fsn-print-download-${Date.now()}.pdf`;
      const path = `${ctx.sandboxDir}/${fileName}`;
      await d.saveAs(path);
      downloadPath = path;
      return d;
    })
    .catch(() => null);

  let clicked = false;
  for (const sel of [
    'button:has-text("Print Selected Document")',
    'button[aria-label*="Print"]',
    'button:has-text("Print")',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click();
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    return { captured: false, source: "fsn-new", text: "", reason: "print button not found" };
  }

  await sleep(3000);
  printCalled = await page.evaluate(() => !!(window as any).__printIntercepted);
  await Promise.race([popupPromise, downloadPromise, sleep(5000)]);

  if (popupPage) {
    const p = popupPage as Page;
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 15000 });
      await sleep(3000);
      await p.emulateMedia({ media: "screen" });
      await scrollPass(p, 20);
      await sleep(1000);

      let text = await p.evaluate(() => document.body?.innerText || "");
      const pdfPath = `${ctx.sandboxDir}/fsn-print-popup-${Date.now()}.pdf`;
      await p.pdf({
        path: pdfPath,
        format: "Letter",
        printBackground: true,
        margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
      });

      // If the popup is a PDF viewer (canvas-based, no text DOM), pull text
      // from the PDF we just rendered.
      if (text.length < 200) {
        const fromPdf = await extractPdfText(pdfPath);
        if (fromPdf.length > text.length) text = fromPdf;
      }

      return {
        captured: true,
        source: "fsn-print-popup",
        text,
        pdfPath,
      };
    } finally {
      await p.close().catch(() => {});
    }
  }

  if (downloadPath) {
    const text = await extractPdfText(downloadPath);
    return {
      captured: true,
      source: "fsn-print-download",
      text,
      pdfPath: downloadPath,
    };
  }

  if (printCalled) {
    await page.emulateMedia({ media: "screen" });
    await sleep(1500);
    const text = await page.evaluate(() => document.body?.innerText || "");
    return { captured: true, source: "fsn-new", text };
  }

  return { captured: false, source: "fsn-new", text: "", reason: "no popup, no download, no intercept" };
}
