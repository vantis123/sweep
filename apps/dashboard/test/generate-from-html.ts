/**
 * End-to-end: take a real IIQ-downloaded HTML report, extract accounts with
 * cheerio, build Sweep's CreditReport shape, run through listDisputables +
 * buildAffidavitInputs + renderLetterPdf → 3 dispute letters.
 *
 *   npx tsx apps/dashboard/test/generate-from-html.ts <html-file> <client-name>
 */

import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import * as cheerio from "cheerio";

import type {
  Account,
  AccountCategory,
  Bureau,
  BureauAccountDetail,
  CreditReport,
  PersonalInfo,
} from "@sweep/parsers";
import {
  ACCOUNT_DISPUTE_REASONS,
  PERSONAL_INFO_DISPUTE_REASONS,
  buildAffidavitInputs,
  listDisputables,
  listPersonalInfo,
  renderAffidavitHtml,
  type ItemSelection,
  type PersonalInfoSelection,
} from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");

function categorize(text: string): AccountCategory | null {
  const l = text.toLowerCase();
  // Prefer chargeoff over collection when status is "Collection/Chargeoff"
  if (l.includes("charge") && (l.includes("off") || l.includes("-off"))) return "chargeoff";
  if (l.includes("collection")) return "collection";
  if (l.includes("foreclosure")) return "foreclosure";
  if (l.includes("repossession")) return "repossession";
  if (l.includes("bankruptcy")) return "bankruptcy";
  if (/120\s*days/.test(l) || /late\s*120/.test(l)) return "late120";
  if (/90\s*days/.test(l) || /late\s*90/.test(l)) return "late90";
  if (/60\s*days/.test(l) || /late\s*60/.test(l)) return "late60";
  if (/30\s*days/.test(l) || /late\s*30/.test(l)) return "late30";
  return null;
}

interface ParsedAccount {
  creditor: string;
  isNegative: boolean;
  category: AccountCategory;
  perBureau: {
    transunion: Record<string, string>;
    experian: Record<string, string>;
    equifax: Record<string, string>;
  };
}

function extractFromHTML(html: string): {
  referenceNumber: string | null;
  reportDate: string | null;
  accounts: ParsedAccount[];
  personalInfo: PersonalInfo;
} {
  const $ = cheerio.load(html);
  const allText = $("body").text();
  const referenceNumber = allText.match(/Reference\s*#:\s*([A-Z0-9]+)/)?.[1] ?? null;
  const reportDate = allText.match(/Report Date:\s*([0-9/-]+)/)?.[1] ?? null;

  // v3: walk every div.sub_header and take only FORWARD SIBLINGS within the
  // same parent container (don't cross into other accounts' containers via
  // document-order walks). Each account's data lives in tables that are
  // siblings of its sub_header div.
  const subHeaders = $("div.sub_header").toArray();
  const sections: { creditor: string; tables: cheerio.Element[] }[] = [];
  for (const header of subHeaders) {
    const creditor = $(header).text().replace(/\s+/g, " ").trim();
    if (!creditor) continue;
    const tables: cheerio.Element[] = [];
    let sib = $(header).next();
    while (sib.length > 0) {
      if (sib.hasClass("sub_header")) break;
      if (sib.is("table")) {
        const hasAcct = sib.find("tr").toArray().some((r) => /Account\s*#/i.test($(r).text()));
        if (hasAcct) tables.push(sib.get(0) as cheerio.Element);
      }
      // Also check descendants for any account tables (IIQ sometimes nests)
      sib.find("table").each((_, t) => {
        const hasAcct = $(t).find("tr").toArray().some((r) => /Account\s*#/i.test($(r).text()));
        if (hasAcct && !tables.includes(t)) tables.push(t);
      });
      sib = sib.next();
    }
    if (tables.length > 0) sections.push({ creditor, tables });
  }

  const accounts: ParsedAccount[] = [];
  for (const sec of sections) {
    const current: ParsedAccount = {
      creditor: sec.creditor,
      isNegative: false,
      category: "unknown" as AccountCategory,
      perBureau: { transunion: {}, experian: {}, equifax: {} },
    };
    for (const table of sec.tables) {
    const rows = $(table).find("tr").toArray();
    if (rows.length === 0) continue;
    const firstRowCells = $(rows[0]!).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
    let bureauForCol: ("transunion" | "experian" | "equifax" | "")[] = [];
    const isHeader = firstRowCells.some((c) => /^(transunion|experian|equifax)$/i.test(c));
    if (isHeader) {
      bureauForCol = firstRowCells.map((c) => {
        const l = c.toLowerCase();
        if (l === "transunion") return "transunion";
        if (l === "experian") return "experian";
        if (l === "equifax") return "equifax";
        return "";
      });
    } else {
      bureauForCol = ["", "transunion", "experian", "equifax"];
    }
    const startIdx = isHeader ? 1 : 0;
    for (let i = startIdx; i < rows.length; i++) {
      const cells = $(rows[i]!).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
      if (cells.length < 2) continue;
      const label = (cells[0] ?? "").replace(/:$/, "");
      if (!label) continue;
      for (let c = 1; c < cells.length; c++) {
        const bureau = bureauForCol[c];
        if (!bureau) continue;
        const v = cells[c] ?? "";
        if (v && v !== "-") {
          current.perBureau[bureau][label] = v;
          if (/status|payment status|comments|bureau code|remarks/i.test(label)) {
            const cat = categorize(v);
            if (cat) {
              current.isNegative = true;
              // Prefer most severe category (chargeoff > collection > late30)
              const rank: Record<string, number> = { bankruptcy:100, foreclosure:90, repossession:80, chargeoff:70, collection:60, late150:55, late120:50, late90:40, late60:30, late30:20 };
              if ((rank[cat] ?? 0) > (rank[current.category] ?? 0)) current.category = cat;
            }
          }
        }
      }
    }
    }
    accounts.push(current);
  }

  // Personal info — look for the first section with TU/EX/EQ header that has
  // labels like "Name:" and "Date of Birth:"
  const personalInfo: PersonalInfo = {};
  for (const t of $("table").toArray()) {
    const tableText = $(t).text().toLowerCase();
    if (!tableText.includes("name:") || !tableText.includes("date of birth")) continue;
    const rows = $(t).find("tr").toArray();
    let bureauForCol: ("transunion" | "experian" | "equifax" | "")[] = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = $(rows[i]!).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
      if (cells.some((c) => /^(transunion|experian|equifax)$/i.test(c))) {
        bureauForCol = cells.map((c) => {
          const l = c.toLowerCase();
          if (l === "transunion") return "transunion";
          if (l === "experian") return "experian";
          if (l === "equifax") return "equifax";
          return "";
        });
        continue;
      }
      if (bureauForCol.length === 0) continue;
      const label = (cells[0] ?? "").replace(/:$/, "").toLowerCase();
      const assignTo = (target: "name" | "currentAddress" | "employer" | "birthYear" | "ssnLast4") => {
        if (!personalInfo[target]) personalInfo[target] = {} as any;
        for (let c = 1; c < cells.length; c++) {
          const bureau = bureauForCol[c];
          if (!bureau) continue;
          const v = cells[c] ?? "";
          if (v && v !== "-") (personalInfo[target] as any)[bureau] = v;
        }
      };
      if (label === "name") assignTo("name");
      else if (label === "current address(es)") assignTo("currentAddress");
      else if (label === "employers") assignTo("employer");
      else if (label === "date of birth") assignTo("birthYear");
    }
    break;
  }

  return { referenceNumber, reportDate, accounts, personalInfo };
}

function toCreditReport(extracted: ReturnType<typeof extractFromHTML>): CreditReport {
  const accounts: Account[] = extracted.accounts.map((a) => {
    const toDetail = (raw: Record<string, string>): BureauAccountDetail | undefined => {
      if (Object.keys(raw).length === 0) return undefined;
      const det: BureauAccountDetail = {
        accountNumber: raw["Account #"] || raw["Account Number"],
        accountType: raw["Account Type"],
        accountTypeDetail: raw["Account Type - Detail"],
        accountStatus: raw["Account Status"],
        ownership: raw["Bureau Code"],
        dateOpened: raw["Date Opened"],
        dateClosed: raw["Date Closed"],
        balance: parseMoney(raw["Balance"]),
        highCredit: parseMoney(raw["High Credit"]),
        creditLimit: parseMoney(raw["Credit Limit"]),
        pastDue: parseMoney(raw["Past Due"]),
        paymentStatus: raw["Payment Status"],
        lastReported: raw["Last Reported"],
        lastPayment: raw["Date of Last Payment"],
        comments: raw["Comments"],
        rawFields: raw,
      };
      return det;
    };
    return {
      creditor: a.creditor,
      category: a.category,
      isNegative: a.isNegative,
      bureaus: {
        transunion: toDetail(a.perBureau.transunion),
        experian: toDetail(a.perBureau.experian),
        equifax: toDetail(a.perBureau.equifax),
      },
    };
  });
  return {
    platform: "iiq",
    reportDate: extracted.reportDate,
    referenceNumber: extracted.referenceNumber,
    scores: { equifax: null, experian: null, transunion: null },
    summary: { equifax: {}, experian: {}, transunion: {} },
    accounts,
    inquiries: [],
    publicRecords: [],
    personalInfo: extracted.personalInfo,
    warnings: [],
    errors: [],
  };
}

function parseMoney(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-?\$?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return parseFloat(m[1]!.replace(/,/g, ""));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
}

async function main() {
  const htmlPath = process.argv[2];
  const clientNameArg = process.argv[3] ?? "Test Client";
  if (!htmlPath) {
    console.error("usage: tsx generate-from-html.ts <html-file> <client-name>");
    process.exit(1);
  }
  const html = await readFile(htmlPath, "utf8");
  console.log(`\n  HTML: ${(html.length / 1024).toFixed(1)} KB`);

  console.log(`\n  Step 1: Extract with cheerio`);
  const extracted = extractFromHTML(html);
  console.log(`    accounts:    ${extracted.accounts.length}`);
  console.log(`    negatives:   ${extracted.accounts.filter((a) => a.isNegative).length}`);
  console.log(`    personalInfo:`, Object.keys(extracted.personalInfo));

  console.log(`\n  Step 2: Convert to CreditReport`);
  const report = toCreditReport(extracted);

  console.log(`\n  Step 3: listDisputables`);
  const disputables = listDisputables(report);
  console.log(`    total flagged: ${disputables.length}`);
  const byBureau: Record<string, number> = {};
  for (const d of disputables) byBureau[d.bureau] = (byBureau[d.bureau] ?? 0) + 1;
  console.log(`    per bureau:`, byBureau);

  console.log(`\n  Step 4: Build affidavit inputs`);
  const itemSelections: ItemSelection[] = disputables.map((d, i) => ({
    id: d.id,
    bureau: d.bureau,
    creditor: d.creditor,
    detail: d.detail,
    reasonId: ACCOUNT_DISPUTE_REASONS[i % ACCOUNT_DISPUTE_REASONS.length].id,
  }));
  const piCandidates = listPersonalInfo(report);
  const piSelections: PersonalInfoSelection[] = [];

  // Pull a usable client name + address from personalInfo
  const piName = report.personalInfo.name;
  const fullName = piName?.experian ?? piName?.equifax ?? piName?.transunion ?? clientNameArg;
  const piAddr = report.personalInfo.currentAddress;
  const firstAddr = piAddr?.experian ?? piAddr?.equifax ?? piAddr?.transunion ?? "";
  let address = firstAddr;
  let cityStateZip = "";
  const lc = firstAddr.lastIndexOf(",");
  if (lc > -1) {
    const slc = firstAddr.lastIndexOf(",", lc - 1);
    if (slc > -1) {
      address = firstAddr.slice(0, slc).trim();
      cityStateZip = firstAddr.slice(slc + 1).trim();
    } else {
      address = firstAddr.slice(0, lc).trim();
      cityStateZip = firstAddr.slice(lc + 1).trim();
    }
  }

  const perBureauLetters = buildAffidavitInputs({
    report,
    client: {
      fullName,
      address,
      cityStateZip,
      dob: "",
      ssnLast4: "",
    },
    itemSelections,
    personalInfoSelections: piSelections,
  });

  console.log(`    letters to render: ${perBureauLetters.length}`);

  console.log(`\n  Step 5: Render PDFs`);
  const clientSlug = slugify(clientNameArg);
  const outDir = resolve(LETTERS_DIR, clientSlug);
  await mkdir(outDir, { recursive: true });
  const timestamp = Date.now();

  for (const { bureau, input } of perBureauLetters) {
    const html = await renderAffidavitHtml(input);
    const fileName = `sweep-${clientSlug}-${bureau}-${timestamp}.pdf`;
    const outPath = resolve(outDir, fileName);
    await renderLetterPdf({
      html,
      fcra605bPath: FCRA_605B_PATH,
      breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
      outputPath: outPath,
    });
    const size = statSync(outPath).size;
    console.log(`    ✓ ${bureau.padEnd(11)} ${(size / 1024).toFixed(1)} KB → ${outPath}`);
  }

  console.log(`\n  ✓ Done. ${perBureauLetters.length} letters in ${outDir}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
