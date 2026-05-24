/**
 * Bank parsers — test runner.
 * Runs both parsers against real captured fixtures and prints structured results.
 *
 * Run: npm run test -w @sweep/parsers
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIIQ } from "../src/iiq.ts";
import { parseFSN } from "../src/fsn.ts";
import type { CreditReport } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../fixtures");

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function summarize(label: string, report: CreditReport): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  Platform:   ${report.platform}`);
  console.log(`  Report Date: ${report.reportDate ?? "—"}`);
  console.log(`  Reference #: ${report.referenceNumber ?? "—"}`);
  console.log(
    `  Scores:     EQ=${report.scores.equifax ?? "N/A"}  EX=${report.scores.experian ?? "N/A"}  TU=${report.scores.transunion ?? "N/A"}`
  );
  console.log(`  Accounts:   ${report.accounts.length} total`);
  const negatives = report.accounts.filter((a) => a.isNegative);
  console.log(`  Negative:   ${negatives.length}`);
  console.log(`  Positive:   ${report.accounts.length - negatives.length}`);

  // Summary per bureau
  for (const b of ["equifax", "experian", "transunion"] as const) {
    const s = report.summary[b];
    if (s && Object.keys(s).length > 0) {
      const parts: string[] = [];
      if (s.totalAccounts !== undefined) parts.push(`total=${s.totalAccounts}`);
      if (s.totalCreditLimit !== undefined) parts.push(`limit=$${s.totalCreditLimit}`);
      if (s.creditUtilization !== undefined) parts.push(`util=${s.creditUtilization}%`);
      if (s.inquiries !== undefined) parts.push(`inq=${s.inquiries}`);
      if (s.publicRecords !== undefined) parts.push(`pr=${s.publicRecords}`);
      if (s.positiveAccounts !== undefined) parts.push(`pos=${s.positiveAccounts}`);
      if (s.negativeAccounts !== undefined) parts.push(`neg=${s.negativeAccounts}`);
      console.log(`  ${b.padEnd(11)}: ${parts.join(", ")}`);
    }
  }

  // Sample first 5 accounts
  if (report.accounts.length > 0) {
    console.log(`\n  Sample accounts:`);
    for (const a of report.accounts.slice(0, 5)) {
      const negFlag = a.isNegative ? "⚠️" : "✅";
      console.log(`    ${negFlag} ${a.creditor} [${a.category}]`);
    }
  }

  // Categories breakdown
  const byCategory: Record<string, number> = {};
  for (const a of report.accounts) {
    byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
  }
  if (Object.keys(byCategory).length > 0) {
    console.log(`  Categories:`);
    for (const [k, v] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k}: ${v}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log(`  Warnings: ${report.warnings.slice(0, 3).join(" | ")}${report.warnings.length > 3 ? ` (+${report.warnings.length - 3} more)` : ""}`);
  }
  if (report.errors.length > 0) {
    console.log(`  Errors:   ${report.errors.join(" | ")}`);
  }
}

// ── IIQ test ──
console.log("Running IIQ parser tests against Hannah's report...");
const iiqText = readFileSync(resolve(FIXTURES, "iiq-hannah.txt"), "utf-8");
const iiqReport = parseIIQ(iiqText);
summarize("IIQ — Hannah Wiblin", iiqReport);

assert(iiqReport.platform === "iiq", "IIQ platform set");
assert(iiqReport.errors.length === 0, "IIQ no errors");
assert(iiqReport.scores.equifax !== null || iiqReport.scores.experian !== null || iiqReport.scores.transunion !== null, "IIQ at least one score parsed");
assert(iiqReport.accounts.length > 0, "IIQ accounts parsed");
assert(
  iiqReport.accounts.some((a) => a.isNegative),
  "IIQ at least one negative account flagged"
);

// ── FSN test ──
console.log("\nRunning FSN parser tests against Adam's report...");
const fsnText = readFileSync(resolve(FIXTURES, "fsn-adam.txt"), "utf-8");
const fsnReport = parseFSN(fsnText);
summarize("FSN — fixture report", fsnReport);

assert(fsnReport.platform === "fsn", "FSN platform set");
assert(fsnReport.errors.length === 0, "FSN no errors");
assert(
  fsnReport.scores.equifax !== null && fsnReport.scores.experian !== null && fsnReport.scores.transunion !== null,
  "FSN all 3 scores parsed"
);
assert(fsnReport.accounts.length > 0, "FSN tradelines parsed");
assert(
  fsnReport.accounts.some((a) => a.isNegative),
  "FSN at least one negative account flagged"
);
assert(
  fsnReport.summary.equifax.totalAccounts !== undefined,
  "FSN Equifax summary populated"
);
assert(
  fsnReport.summary.transunion.totalAccounts !== undefined,
  "FSN TransUnion summary populated"
);

// ── Final ──
console.log(`\n══════════════════════════════════`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`══════════════════════════════════\n`);
process.exit(failed > 0 ? 1 : 0);
