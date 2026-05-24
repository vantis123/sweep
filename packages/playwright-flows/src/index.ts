/**
 * @sweep/playwright-flows
 *
 *   captureFSN({ username, password })  →  Promise<CaptureResult>
 *   captureIIQ({ username, password, last4 })  →  Promise<CaptureResult>
 *
 * Headed by default — Skool users see the bot work, builds trust.
 * Returns text suitable for piping into @sweep/parsers.
 */

import { chromium } from "playwright";
import { fsnLogin, fsnCaptureReport } from "./fsn.ts";
import { iiqLogin, iiqCaptureReport } from "./iiq.ts";
import { defaultLogger, ensureSandbox } from "./util.ts";
import type {
  CaptureOptions,
  CaptureResult,
  FlowContext,
} from "./types.ts";

export type {
  CaptureCredentials,
  CaptureOptions,
  CaptureResult,
  CaptureSource,
  Platform,
} from "./types.ts";

// Re-export the inner login/capture functions so test harnesses (like the
// stepper) can drive only part of the flow without duplicating Bank's code.
export { iiqLogin, iiqCaptureReport } from "./iiq.ts";
export { fsnLogin, fsnCaptureReport } from "./fsn.ts";

export async function captureFSN(opts: CaptureOptions): Promise<CaptureResult> {
  return runFlow("fsn", opts, async (ctx) => {
    await fsnLogin(ctx, opts.username, opts.password);
    return fsnCaptureReport(ctx);
  });
}

export async function captureIIQ(opts: CaptureOptions): Promise<CaptureResult> {
  return runFlow("iiq", opts, async (ctx) => {
    await iiqLogin(ctx, opts.username, opts.password, opts.last4);
    return iiqCaptureReport(ctx);
  });
}

// ── plumbing ─────────────────────────────────────────────────────

async function runFlow(
  platform: "fsn" | "iiq",
  opts: CaptureOptions,
  fn: (ctx: FlowContext) => Promise<{ text: string; source: CaptureResult["source"]; pdfPath?: string }>
): Promise<CaptureResult> {
  const log = opts.onLog ?? defaultLogger;
  const sandboxDir = await ensureSandbox(opts.sandboxDir);
  const headed = opts.headed ?? true;

  log(`Bank capture — ${platform.toUpperCase()} — ${opts.username}`);
  log(`Headed: ${headed} · sandbox: ${sandboxDir}`);

  // Anti-bot-detection setup. IIQ and the new FSN tabbed UI both fingerprint
  // for Playwright/headless via navigator.webdriver, missing plugins, etc.
  // Without these flags + initScript, IIQ returns blank pages and FSN renders
  // a collapsed layout that's missing the d-grid CSS classes parseFSN3B keys
  // off of. Same setup as apps/dashboard/test/validate-live-pulls.ts which is
  // the parser's known-good test harness.
  const browser = await chromium.launch({
    headless: !headed,
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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();

  const ctx: FlowContext = {
    page,
    context,
    sandboxDir,
    log,
    warnings: [],
    screenshots: [],
  };

  try {
    const out = await fn(ctx);
    log(`Capture complete — ${out.text.length} chars`);
    return {
      ok: out.text.length > 0,
      platform,
      source: out.source,
      text: out.text,
      pdfPath: out.pdfPath,
      screenshots: ctx.screenshots,
      warnings: ctx.warnings,
      reportUrl: page.url(),
    };
  } catch (err) {
    const msg = (err as Error).message;
    log(`Capture failed: ${msg}`);
    return {
      ok: false,
      platform,
      source: platform === "iiq" ? "iiq-credit-report" : "fsn-new",
      text: "",
      screenshots: ctx.screenshots,
      warnings: ctx.warnings,
      error: msg,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
