/**
 * IdentityIQ capture flow.
 *
 *   1. Login at member.identityiq.com
 *   2. If a security-question page appears, fill the visible non-password
 *      input with the user's last-4 SSN (their security answer is always last 4).
 *   3. Navigate to /CreditReport.aspx, scroll to load lazy content.
 *   4. Capture body innerText.
 */

import { sleep, scrollPass, snap } from "./util.ts";
import type { CaptureSource, FlowContext } from "./types.ts";

export async function iiqLogin(
  ctx: FlowContext,
  username: string,
  password: string,
  last4: string | undefined
) {
  const page = ctx.page;

  ctx.log("  -> Navigating to member.identityiq.com");
  await page.goto("https://member.identityiq.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(3000);

  ctx.log("  -> Filling credentials");
  await page.waitForSelector("#txtUsername", { state: "visible", timeout: 20000 });
  await page.fill("#txtUsername", username);
  await sleep(500);
  await page.fill("#txtPassword", password);
  await sleep(700);

  await page.click("#imgBtnLogin");

  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 });
  } catch {
    await sleep(7000);
  }
  await sleep(3000);

  // Detect "Invalid login attempt" / "Incorrect password" / "Wrong credentials"
  // before we waste another 60s trying to navigate a failed-login page.
  const loginErrorText = await page.evaluate(() => {
    const t = (document.body?.innerText ?? "").toLowerCase();
    if (t.includes("invalid login attempt")) return "Invalid login attempt — credentials stored for this client are wrong or expired. Refresh them and re-run.";
    if (t.includes("invalid username") || t.includes("invalid password")) return "Invalid username/password — credentials stored for this client are wrong.";
    if (t.includes("account locked") || t.includes("temporarily locked")) return "Account is locked. Have the client unlock via IIQ password reset, then re-run.";
    return null;
  }).catch(() => null);
  if (loginErrorText) {
    throw new Error(loginErrorText);
  }

  const url = page.url();
  if (url.includes("security") || url.includes("verify")) {
    ctx.log("  -> Security page detected — supplying last 4 SSN");
    if (!last4) {
      throw new Error("IIQ requires last4 SSN for the security challenge but none was provided");
    }

    await page.waitForSelector("input:visible", { timeout: 10000 }).catch(() => {});
    await sleep(1000);

    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input")).map((i) => ({
        type: i.type,
        id: i.id,
        name: i.name,
        visible: i.offsetParent !== null && i.offsetWidth > 0,
      }));
    });

    const target = inputs.find(
      (i) =>
        i.visible &&
        !["hidden", "submit", "button", "checkbox", "radio", "password"].includes(i.type)
    );

    if (target) {
      const sel = target.id ? `#${target.id}` : `input[name="${target.name}"]`;
      await page.fill(sel, last4);
    } else {
      await page.keyboard.press("Tab");
      await sleep(300);
      await page.keyboard.type(last4, { delay: 80 });
    }
    await sleep(600);

    let submitted = false;
    for (const sel of [
      'button:has-text("Submit")',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Verify")',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          submitted = true;
          break;
        }
      } catch {}
    }
    if (!submitted) {
      await page.keyboard.press("Enter");
    }

    try {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      await sleep(8000);
    }
    await sleep(3000);
    ctx.log(`  -> Post-security URL: ${page.url()}`);
  }

  ctx.log(`  -> Logged in. URL: ${page.url()}`);
}

export async function iiqCaptureReport(
  ctx: FlowContext
): Promise<{ text: string; source: CaptureSource; pdfPath?: string }> {
  const page = ctx.page;

  // 1. Force-navigate to the canonical full-report URL. The dashboard's
  //    "View Latest Report" lands on a summary that hides most accounts.
  ctx.log("  -> [1/3] Navigating to CreditReport.aspx");
  await page.goto("https://member.identityiq.com/CreditReport.aspx", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  }).catch(() => {});
  await sleep(4000);

  // 2. Override window.print so the OS print dialog never appears when we
  //    click IIQ's own "Print this page" link (which calls PrintPage() →
  //    window.print()). page.pdf() works independently via the CDP API.
  await page.evaluate(() => {
    // @ts-ignore
    (window as any).print = () => {};
  });

  // 3. Click "Print this page" — IIQ's PrintPage() expands the full report
  //    for printing (hides UI chrome, expands accounts).
  ctx.log("  -> [2/3] Clicking 'Print this page'");
  try {
    await page
      .locator('a:has-text("Print this page")')
      .first()
      .click({ timeout: 5000 });
    await sleep(3000);
  } catch (e) {
    ctx.log(`     Print link skipped: ${(e as Error).message.split("\n")[0]}`);
  }

  // 4. Render the page as a vector PDF. scale=0.6 keeps the report compact
  //    so Chromium can fit ~35 pages of accounts within its print-engine
  //    size limits.
  ctx.log("  -> [3/3] Rendering PDF via page.pdf()");
  const pdfPath = `${ctx.sandboxDir}/iiq-credit-report-${Date.now()}.pdf`;
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: pdfPath,
    format: "Letter",
    printBackground: true,
    scale: 0.6,
    margin: { top: "0.3in", bottom: "0.3in", left: "0.3in", right: "0.3in" },
  });
  ctx.log(`     PDF saved → ${pdfPath}`);

  // 5. Extract text for the dashboard (downstream code may key off it).
  //    The PDF is the canonical source — parseIIQPdf in @sweep/parsers reads
  //    positional info via pdfjs-dist for accurate bureau-column mapping.
  const { PDFParse } = await import("pdf-parse");
  const { readFile } = await import("node:fs/promises");
  const pdfBytes = await readFile(pdfPath);
  const pdfParser = new PDFParse({ data: pdfBytes });
  const pdfParsed = await pdfParser.getText();
  const text = pdfParsed.text;
  ctx.log(`  -> Extracted ${text.length} chars from PDF`);

  return { text, source: "iiq-credit-report", pdfPath };
}

async function clickFirstMatch(
  page: import("playwright").Page,
  ctx: FlowContext,
  selectors: string[],
  timeoutPerSelectorMs: number,
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const link = page.locator(sel).first();
      await link.waitFor({ state: "visible", timeout: timeoutPerSelectorMs });
      await link.click();
      ctx.log(`     clicked: ${sel}`);
      return true;
    } catch {}
  }
  return false;
}

async function waitForReportContent(page: import("playwright").Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate(() => {
      const t = document.body?.innerText?.toLowerCase() ?? "";
      const hasHeading = t.includes("three bureau credit report") || t.includes("3 bureau credit report");
      const allThree = t.includes("equifax") && t.includes("experian") && t.includes("transunion");
      return hasHeading || allThree;
    });
    if (found) return true;
    await sleep(1000);
  }
  return false;
}

async function clickMostRecentReportHistoryDate(
  page: import("playwright").Page,
  ctx: FlowContext
): Promise<boolean> {
  // The Report History block lists clickable dates like "05/22/2026 - 3B".
  // Click the first one (most recent).
  const candidates = [
    'a:has-text("- 3B")',
    'a:has-text("3B")',
    'a[href*="CreditReport"]:has-text("/")',
    'button:has-text("- 3B")',
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click();
        ctx.log(`     clicked Report History date via ${sel}`);
        return true;
      }
    } catch {}
  }
  return false;
}
