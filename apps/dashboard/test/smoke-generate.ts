/**
 * Smoke test — runs the letter-engine + pdf-renderer end-to-end on a fake
 * CreditReport so we can verify a real Affidavit of Truth PDF comes out the
 * other side without needing live FSN/IIQ creds.
 *
 *   tsx apps/dashboard/test/smoke-generate.ts
 *
 * On success: three PDFs land in letters/smoke-test/, one per bureau.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

import type { CreditReport } from "@sweep/parsers";
import {
  buildAffidavitInputs,
  listDisputables,
  listPersonalInfo,
  renderAffidavitHtml,
  ACCOUNT_DISPUTE_REASONS,
  PERSONAL_INFO_DISPUTE_REASONS,
  type ItemSelection,
  type PersonalInfoSelection,
} from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const OUT_DIR = resolve(REPO_ROOT, "letters", "smoke-test");

function mockReport(): CreditReport {
  return {
    platform: "fsn",
    reportDate: "2026-05-23",
    scores: { equifax: 542, experian: 538, transunion: 551 },
    summary: {
      equifax: { totalAccounts: 8, negativeAccounts: 3, inquiries: 4 },
      experian: { totalAccounts: 8, negativeAccounts: 3, inquiries: 5 },
      transunion: { totalAccounts: 7, negativeAccounts: 2, inquiries: 3 },
    },
    accounts: [
      {
        creditor: "PORTFOLIO RECOVERY ASSOC",
        category: "collection",
        isNegative: true,
        bureaus: {
          experian: { accountNumber: "PR-44182", accountStatus: "Collection", balance: 1247, dateOpened: "2024-08-12", paymentStatus: "In Collection" },
          equifax: { accountNumber: "PR-44182", accountStatus: "Collection", balance: 1247, dateOpened: "2024-08-12", paymentStatus: "In Collection" },
          transunion: { accountNumber: "PR-44182", accountStatus: "Collection", balance: 1247, dateOpened: "2024-08-12", paymentStatus: "In Collection" },
        },
      },
      {
        creditor: "CAPITAL ONE BANK USA",
        category: "chargeoff",
        isNegative: true,
        bureaus: {
          experian: { accountNumber: "517805XX", accountStatus: "Charged Off", balance: 2840, dateOpened: "2022-03-04", paymentStatus: "Charge Off" },
          equifax: { accountNumber: "517805XX", accountStatus: "Charged Off", balance: 2840, dateOpened: "2022-03-04", paymentStatus: "Charge Off" },
        },
      },
      {
        creditor: "MIDLAND CREDIT MGMT",
        category: "collection",
        isNegative: true,
        bureaus: {
          experian: { accountNumber: "MCM-9921", accountStatus: "Collection", balance: 612, dateOpened: "2025-01-22", paymentStatus: "In Collection" },
          transunion: { accountNumber: "MCM-9921", accountStatus: "Collection", balance: 612, dateOpened: "2025-01-22", paymentStatus: "In Collection" },
        },
      },
      {
        creditor: "CHASE CARD SERVICES",
        category: "current",
        isNegative: false,
        bureaus: {
          experian: { accountNumber: "414709XX", accountStatus: "Open", balance: 410, creditLimit: 4500, paymentStatus: "Current" },
          equifax: { accountNumber: "414709XX", accountStatus: "Open", balance: 410, creditLimit: 4500, paymentStatus: "Current" },
          transunion: { accountNumber: "414709XX", accountStatus: "Open", balance: 410, creditLimit: 4500, paymentStatus: "Current" },
        },
      },
    ],
    inquiries: [
      { bureau: "experian", creditor: "ONEMAIN FINANCIAL", date: "2025-11-04", type: "hard" },
      { bureau: "experian", creditor: "LENDINGTREE", date: "2025-09-21", type: "hard" },
      { bureau: "equifax", creditor: "BEST EGG", date: "2025-10-15", type: "hard" },
    ],
    publicRecords: [
      { bureau: "experian", type: "Civil Judgment", date: "2024-02-10", amount: 1850, status: "Satisfied" },
    ],
    personalInfo: {
      name: { experian: "JOHN Q PUBLIC", equifax: "JOHN PUBLIC", transunion: "J PUBLIC" },
      currentAddress: {
        experian: "445 OAK ST, AUSTIN, TX 78701",
        equifax: "445 OAK ST, AUSTIN, TX 78701",
        transunion: "12 OLD DRIVE, HOUSTON, TX 77002",
      },
      previousAddresses: {
        experian: ["88 PINE LN, DALLAS, TX 75201"],
      },
      employer: { experian: "ACME LOGISTICS", equifax: "ACME LOGISTICS LLC" },
      phone: { experian: "(512) 555-0143" },
      ssnLast4: { experian: "4271", equifax: "4271", transunion: "4271" },
      birthYear: { experian: "1987" },
    },
    warnings: [],
    errors: [],
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const report = mockReport();

  const disputables = listDisputables(report);
  const piCandidates = listPersonalInfo(report);

  console.log(`\n  Disputables flagged: ${disputables.length}`);
  console.log(`  Personal-info candidates: ${piCandidates.length}`);

  // Assert the flagger caught the negatives we planted.
  const byBureau: Record<string, number> = {};
  for (const d of disputables) byBureau[d.bureau] = (byBureau[d.bureau] ?? 0) + 1;
  console.log(`  Disputables per bureau:`, byBureau);

  if (!byBureau.experian || !byBureau.equifax || !byBureau.transunion) {
    throw new Error("Expected at least one disputable per bureau — fix listDisputables.");
  }

  // Cycle through reasons so we exercise multiple template rows.
  const itemSelections: ItemSelection[] = disputables.map((d, i) => ({
    id: d.id,
    bureau: d.bureau,
    creditor: d.creditor,
    detail: d.detail,
    reasonId: ACCOUNT_DISPUTE_REASONS[i % ACCOUNT_DISPUTE_REASONS.length].id,
  }));

  // Dispute one address per bureau where the report has one.
  const piSelections: PersonalInfoSelection[] = piCandidates
    .filter((c) => c.field === "currentAddress")
    .map((c, i) => ({
      id: c.id,
      bureau: c.bureau,
      fieldLabel: "Current address",
      value: c.value,
      reasonId: PERSONAL_INFO_DISPUTE_REASONS[i % PERSONAL_INFO_DISPUTE_REASONS.length].id,
    }));

  const perBureau = buildAffidavitInputs({
    report,
    client: {
      fullName: "John Q Public",
      address: "445 OAK ST",
      cityStateZip: "AUSTIN, TX 78701",
      dob: "04/12/1987",
      ssnLast4: "4271",
    },
    itemSelections,
    personalInfoSelections: piSelections,
  });

  console.log(`  Letters to render: ${perBureau.length} (expected 3)\n`);
  if (perBureau.length !== 3) {
    throw new Error(`Expected 3 letters (one per bureau), got ${perBureau.length}`);
  }

  for (const { bureau, input } of perBureau) {
    const html = await renderAffidavitHtml(input);
    if (!html.includes("AFFIDAVIT OF TRUTH")) {
      throw new Error(`Rendered HTML for ${bureau} missing AFFIDAVIT OF TRUTH heading.`);
    }
    if (!html.includes(input.bureau.displayName)) {
      throw new Error(`Rendered HTML for ${bureau} missing bureau name in addressee block.`);
    }
    const outPath = resolve(OUT_DIR, `sweep-smoke-${bureau}.pdf`);
    console.log(`  → rendering ${bureau} → ${outPath}`);
    await renderLetterPdf({
      html,
      fcra605bPath: FCRA_605B_PATH,
      breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
      outputPath: outPath,
    });
    const size = statSync(outPath).size;
    if (size < 20_000) {
      throw new Error(`PDF for ${bureau} is suspiciously small (${size} bytes) — likely a render failure.`);
    }
    console.log(`     ✓ ${(size / 1024).toFixed(1)} KB`);
  }

  console.log(`\n  ✓ Smoke test passed. Three PDFs in ${OUT_DIR}\n`);
}

main().catch((err) => {
  console.error(`\n  ✗ Smoke test failed: ${err.message}\n`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
