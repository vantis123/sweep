import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";
import type { FlowContext } from "./types.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export function defaultLogger(line: string) {
  console.log(`[${ts()}] ${line}`);
}

export async function ensureSandbox(dir: string | undefined): Promise<string> {
  const path = resolve(dir ?? ".bank-sandbox");
  await mkdir(path, { recursive: true });
  return path;
}

export async function snap(
  ctx: FlowContext,
  page: Page,
  label: string
): Promise<string | null> {
  try {
    const path = resolve(ctx.sandboxDir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path, fullPage: true });
    ctx.screenshots.push(path);
    ctx.log(`  -> screenshot: ${path}`);
    return path;
  } catch (err) {
    ctx.log(`  -> screenshot ${label} failed: ${(err as Error).message}`);
    return null;
  }
}

/** Scroll the page to trigger lazy-loaded content. */
export async function scrollPass(page: Page, passes = 20, stepPx = 800, delayMs = 400) {
  await page.evaluate(
    async ({ passes, stepPx, delayMs }) => {
      for (let i = 0; i < passes; i++) {
        window.scrollBy(0, stepPx);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      window.scrollTo(0, 0);
    },
    { passes, stepPx, delayMs }
  );
}

/** Best-effort visible-element finder across a list of selectors. */
export async function findVisible(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible())) return sel;
    } catch {}
  }
  return null;
}
