/**
 * Test the full v7 pipeline end-to-end on Kelly's existing HTML:
 *   extractIIQAccounts → listIIQDisputes → render 3 letters
 *
 *   npx tsx apps/dashboard/test/test-v7-pipeline.ts
 */

import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

import { extractIIQAccounts, listIIQDisputes } from "@sweep/parsers";
import { BUREAU_CONTACTS, ACCOUNT_DISPUTE_REASONS, renderAffidavitHtml, type AffidavitItem } from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");

async function main() {
  const htmlPath = "/Users/Krownz/.sweep/stepper/kelly-report.html";
  console.log(`\n  v7 PIPELINE TEST — ${htmlPath}\n`);

  const html = await readFile(htmlPath, "utf8");
  const extraction = extractIIQAccounts(html);
  const disputes = listIIQDisputes(extraction);
  const counts = {
    transunion: disputes.filter((d) => d.bureau === "transunion").length,
    experian: disputes.filter((d) => d.bureau === "experian").length,
    equifax: disputes.filter((d) => d.bureau === "equifax").length,
  };
  console.log(`  Reference #:  ${extraction.referenceNumber}`);
  console.log(`  Report Date:  ${extraction.reportDate}`);
  console.log(`  Accounts:     ${extraction.accounts.length}`);
  console.log(`  Disputes:     TU=${counts.transunion}  EX=${counts.experian}  EQ=${counts.equifax}`);

  const clientName = "Kelly Michonda V7";
  const clientSlug = "kelly-michonda-v7";
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
    const html = await renderAffidavitHtml({
      client: { fullName: clientName, address: "", cityStateZip: "", dob: "", ssnLast4: "" },
      bureau: BUREAU_CONTACTS[bureau],
      date: dateStr,
      items,
      personalInfoItems: [],
    });
    const fileName = `sweep-v7-${clientSlug}-${bureau}-${ts}.pdf`;
    const outPath = resolve(outDir, fileName);
    await renderLetterPdf({
      html,
      fcra605bPath: FCRA_605B_PATH,
      breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
      outputPath: outPath,
    });
    console.log(`  ✓ ${bureau.padEnd(11)} ${items.length} items  ${(statSync(outPath).size / 1024).toFixed(1)} KB → ${outPath}`);
  }

  console.log(`\n  ✓ Full pipeline works end-to-end with v7.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
