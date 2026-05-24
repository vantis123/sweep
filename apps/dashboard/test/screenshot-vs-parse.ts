/**
 * Render Kelly's IIQ HTML report, screenshot the problem accounts, dump my
 * extracted JSON next to each screenshot. Visual cross-check.
 *
 *   npx tsx apps/dashboard/test/screenshot-vs-parse.ts
 */

import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

const STEPS_DIR = resolve(homedir(), ".sweep", "stepper");
const HTML_PATH = resolve(STEPS_DIR, "kelly-report.html");

const PROBLEM_ACCOUNTS = [
  "SYN/FIRSTDIG",
  "CONN'S SERV",
  "CONNS",
  "RESOURCE ONE",
  "SPRINGOAKS",
  "SPRINGOAKCAP",
  "LVNV FUNDING LLC",
  "ACIMA DIGITAL FKA SIMP",
];

async function main() {
  await mkdir(STEPS_DIR, { recursive: true });
  const html = await readFile(HTML_PATH, "utf8");

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });
  await page.setContent(html, { waitUntil: "domcontentloaded" });

  // Inject the __name shim defensively
  await page.addScriptTag({
    content: "if (typeof __name === 'undefined') { window.__name = function(f){return f}; }",
  });

  for (const target of PROBLEM_ACCOUNTS) {
    console.log(`\n  Looking for sub_header containing "${target}"...`);

    const result = await page.evaluate((q) => {
      const w = window as any;
      const headers = document.querySelectorAll("div.sub_header");
      const matches: { idx: number; text: string; top: number; height: number }[] = [];
      headers.forEach((h, i) => {
        const t = (h.textContent || "").trim();
        if (t === q || t.includes(q)) {
          const r = (h as HTMLElement).getBoundingClientRect();
          matches.push({ idx: i, text: t, top: window.scrollY + r.top, height: r.height });
        }
      });
      return matches;
    }, target);

    if (result.length === 0) {
      console.log(`     no sub_header found`);
      continue;
    }
    console.log(`     ${result.length} sub_header(s) matched`);

    for (let i = 0; i < result.length; i++) {
      const m = result[i]!;
      console.log(`       header idx=${m.idx}  top=${Math.round(m.top)}  text="${m.text}"`);

      // Scroll the header into view then screenshot a region around it
      await page.evaluate(({ top }) => {
        window.scrollTo({ top: Math.max(0, top - 60), behavior: "instant" as ScrollBehavior });
      }, { top: m.top });
      await page.waitForTimeout(200);

      const safeName = target.replace(/[^A-Z0-9]/gi, "_");
      const outPath = resolve(STEPS_DIR, `cmp-${safeName}-${i}.png`);
      await page.screenshot({ path: outPath, fullPage: false, timeout: 8000 });
      console.log(`       saved → ${outPath}`);
    }
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
