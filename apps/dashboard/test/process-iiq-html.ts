/**
 * Take an IIQ-downloaded HTML report, extract its innerText via Playwright
 * (no PDF intermediate), feed to parseIIQ, report what the downstream
 * pipeline would see.
 *
 *   npx tsx apps/dashboard/test/process-iiq-html.ts <html-file>
 */

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";

import { parseIIQ } from "@sweep/parsers";
import { listDisputables, listPersonalInfo } from "@sweep/letter-engine";

async function main() {
  const htmlPath = process.argv[2];
  if (!htmlPath) {
    console.error("usage: tsx process-iiq-html.ts <html-file>");
    process.exit(1);
  }

  console.log(`\n  Source: ${htmlPath}`);
  const html = await readFile(htmlPath, "utf8");
  console.log(`  HTML size: ${(html.length / 1024).toFixed(1)} KB`);

  console.log(`\n  Step 1: Load HTML in Playwright + extract innerText`);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const text = await page.evaluate(() => document.body?.innerText || "");
  await browser.close();
  console.log(`     extracted ${text.length} chars`);
  const textPath = htmlPath.replace(/\.(html|pdf)$/i, "") + "-innerText.txt";
  await writeFile(textPath, text, "utf8");
  console.log(`     saved → ${textPath}`);

  console.log(`\n  Step 2: Header inspection (first 600 chars)`);
  console.log(`     ${text.slice(0, 600).replace(/\n/g, "⏎")}`);

  console.log(`\n  Step 3: Detection-regex check`);
  console.log(`     /Three Bureau Credit Report/i  →  ${/Three Bureau Credit Report/i.test(text)}`);
  console.log(`     /Reference #:/i                →  ${/Reference #:/i.test(text)}`);
  console.log(`     /TransUnionExperianEquifax/i   →  ${/TransUnionExperianEquifax/i.test(text)}`);
  console.log(`     /TransUnion\\s+Experian\\s+Equifax/i → ${/TransUnion\s+Experian\s+Equifax/i.test(text)}`);

  console.log(`\n  Step 4: Run parseIIQ`);
  const report = parseIIQ(text);
  console.log(`     scores:    ${report.scores.equifax} / ${report.scores.experian} / ${report.scores.transunion}`);
  console.log(`     accounts:  ${report.accounts.length}`);
  console.log(`     inquiries: ${report.inquiries.length}`);
  console.log(`     pubRec:    ${report.publicRecords.length}`);
  console.log(`     errors:`, report.errors);
  console.log(`     name:`, report.personalInfo.name);

  console.log(`\n  Step 5: listDisputables / listPersonalInfo`);
  const disp = listDisputables(report);
  const pi = listPersonalInfo(report);
  console.log(`     disputables:        ${disp.length}`);
  console.log(`     personalInfoItems:  ${pi.length}`);
  if (disp.length > 0) {
    const byBureau: Record<string, number> = {};
    for (const d of disp) byBureau[d.bureau] = (byBureau[d.bureau] ?? 0) + 1;
    console.log(`     per bureau:`, byBureau);
    console.log(`     first 6:`);
    disp.slice(0, 6).forEach((d) => console.log(`       ${d.bureau.padEnd(11)} ${d.kind.padEnd(14)} ${d.creditor} — ${d.detail}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
