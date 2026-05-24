/**
 * Replay a real captured IIQ page through Sweep's pipeline.
 *
 * Reads the captured PDF in ~/.sweep/sandbox/, extracts its text, then runs
 * the same code the dashboard /api/pull endpoint runs (no-active-report
 * detection → parser → disputable lister). Tells us exactly what Sweep would
 * have done with this real capture.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PDFParse } from "pdf-parse";

import { parseIIQ } from "@sweep/parsers";
import { listDisputables, listPersonalInfo } from "@sweep/letter-engine";

const SANDBOX = resolve(homedir(), ".sweep", "sandbox");
const PDF_PATH = process.argv[2] ?? resolve(SANDBOX, "iiq-credit-report-1779545397970.pdf");

function detectNoActiveReport(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("purchase report") || lower.includes("purchase your report")) {
    return "Has a Purchase Report button — no active 3-bureau report on the account.";
  }
  if (lower.includes("subscription has expired") || lower.includes("renew your subscription")) {
    return "Subscription expired.";
  }
  if (lower.includes("we were unable to verify") || lower.includes("identity verification")) {
    return "Identity verification step in the way.";
  }
  const bureauHits =
    Number(lower.includes("equifax")) +
    Number(lower.includes("experian")) +
    Number(lower.includes("transunion"));
  if (bureauHits < 2) {
    return `Fewer than 2 bureau names found in the captured text (found ${bureauHits}). Not a real 3-bureau report.`;
  }
  return null;
}

async function main() {
  console.log(`\n  Reading capture: ${PDF_PATH}`);
  const buf = await readFile(PDF_PATH);
  const parser = new PDFParse({ data: buf });
  const parsed = await parser.getText();
  const text = parsed.text;

  console.log(`  Pages: ${parsed.pages ?? parsed.numpages ?? "?"}`);
  console.log(`  Text length: ${text.length} chars`);
  console.log(`  First 240 chars:\n    ${text.slice(0, 240).replace(/\n/g, " ").trim()}`);

  const lower = text.toLowerCase();
  const hits = {
    equifax: lower.includes("equifax"),
    experian: lower.includes("experian"),
    transunion: lower.includes("transunion"),
    purchaseReport: lower.includes("purchase report"),
  };
  console.log(`\n  Markers:`, hits);

  const reason = detectNoActiveReport(text);
  console.log(`\n  detectNoActiveReport →`, reason ? `BLOCK: ${reason}` : `PASS (looks like a real report)`);

  console.log(`\n  Running parseIIQ on the captured text anyway, to show what it would extract...`);
  const report = parseIIQ(text);
  console.log(`    accounts: ${report.accounts.length}`);
  console.log(`    inquiries: ${report.inquiries.length}`);
  console.log(`    publicRecords: ${report.publicRecords.length}`);
  console.log(`    scores: equifax=${report.scores.equifax}, experian=${report.scores.experian}, transunion=${report.scores.transunion}`);
  console.log(`    personalInfo names:`, report.personalInfo.name);

  const disputables = listDisputables(report);
  const pi = listPersonalInfo(report);
  console.log(`\n  listDisputables → ${disputables.length} items`);
  console.log(`  listPersonalInfo → ${pi.length} items`);

  console.log(`\n  Verdict:`);
  if (reason) {
    console.log(`    Sweep would have RETURNED an error and stayed on the form screen.`);
    console.log(`    Error to user: "${reason}"`);
  } else {
    console.log(`    Sweep would have shown the review screen with the data above.`);
  }
  console.log();
}

main().catch((err) => {
  console.error(`  ✗ ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
