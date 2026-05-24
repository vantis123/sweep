/**
 * Compare Sweep's filtered disputables (via v2 sub_header walker + Phillip's
 * filter rules) against the gold-standard list for Kelly.
 */

import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Account, AccountCategory, BureauAccountDetail, CreditReport, PersonalInfo } from "@sweep/parsers";
import { listDisputables } from "@sweep/letter-engine";

const GOLD = [
  "LVNV FUNDING (Original Creditor: 10 JUST ENERGY TEXAS LP)",
  "MIDLAND CRED (Original Creditor: 01 CREDIT ONE BANK N A)",
  "I C SYSTEM (Original Creditor: 11 CHARTER COMMUNICATIONS)",
  "CREDIT COLL (Original Creditor: 06 THE GENERAL INSURANCE COMPANY)",
  "SPRINGOAKCAP (Original Creditor: 12 CELTIC BANK)",
  "LVNV FUNDING (Original Creditor: 12 FIRST DIGITAL FDC SYNOVUS BANK)",
  "PRO COLLECT (Original Creditor: 09 THE FELIX APARTMENTS S2)",
  "SUNRISECRED (Original Creditor: 11 AT T MOBILITY)",
  "TRANSWORLD (Original Creditor: 10 4CHANGE ENERGY COMPANY)",
  "STAFFORD GRP (Original Creditor: 12 GREENWAVE FINANCE LLC)",
  "CAINE & WEINER (Original Creditor: PROGRESSIVE)",
  "SYN/FIRSTDIG",
  "MDG US INC",
  "CONN'S SERV",
  "RESOURCE ONE",
];

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

function categorize(text: string): AccountCategory | null {
  const l = text.toLowerCase();
  if (l.includes("charge") && (l.includes("off") || l.includes("-off"))) return "chargeoff";
  if (l.includes("collection")) return "collection";
  if (l.includes("foreclosure")) return "foreclosure";
  if (l.includes("repossession")) return "repossession";
  if (l.includes("bankruptcy")) return "bankruptcy";
  if (/120\s*days|late\s*120/.test(l)) return "late120";
  if (/90\s*days|late\s*90/.test(l)) return "late90";
  if (/60\s*days|late\s*60/.test(l)) return "late60";
  if (/30\s*days|late\s*30/.test(l)) return "late30";
  return null;
}

function parseMoney(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-?\$?([\d,]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!.replace(/,/g, "")) : null;
}

async function extractAccounts(htmlPath: string): Promise<Account[]> {
  const html = await readFile(htmlPath, "utf8");
  const $ = cheerio.load(html);
  // v3 sibling walker — match generate-from-html.ts
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
      sib.find("table").each((_, t) => {
        const hasAcct = $(t).find("tr").toArray().some((r) => /Account\s*#/i.test($(r).text()));
        if (hasAcct && !tables.includes(t)) tables.push(t);
      });
      sib = sib.next();
    }
    if (tables.length > 0) sections.push({ creditor, tables });
  }

  const accounts: Account[] = [];
  for (const sec of sections) {
    const acct: Account = {
      creditor: sec.creditor,
      category: "unknown" as AccountCategory,
      isNegative: false,
      bureaus: {},
    };
    for (const table of sec.tables) {
      const rows = $(table).find("tr").toArray();
      if (rows.length === 0) continue;
      const firstRowCells = $(rows[0]!).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
      const isHdr = firstRowCells.some((c) => /^(transunion|experian|equifax)$/i.test(c));
      let bureauForCol: ("transunion" | "experian" | "equifax" | "")[] = [];
      if (isHdr) {
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
      const startIdx = isHdr ? 1 : 0;
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
            if (!acct.bureaus[bureau]) acct.bureaus[bureau] = { rawFields: {} };
            const det = acct.bureaus[bureau] as BureauAccountDetail;
            det.rawFields![label] = v;
            if (label === "Account #" || label === "Account Number") det.accountNumber = v;
            if (label === "Account Status") det.accountStatus = v;
            if (label === "Payment Status") det.paymentStatus = v;
            if (label === "Date Opened") det.dateOpened = v;
            if (label === "Date Closed") det.dateClosed = v;
            if (label === "Balance") det.balance = parseMoney(v);
            if (label === "Past Due") det.pastDue = parseMoney(v);
            if (label === "Comments") det.comments = v;
            if (label === "Bureau Code") det.ownership = v;
            if (/status|payment status|comments|bureau code|remarks/i.test(label)) {
              const cat = categorize(v);
              if (cat) {
                acct.isNegative = true;
                const sevRank: Record<string, number> = { bankruptcy:100, foreclosure:90, repossession:80, chargeoff:70, collection:60, late150:55, late120:50, late90:40, late60:30, late30:20 };
                if ((sevRank[cat] ?? 0) > (sevRank[acct.category] ?? 0)) acct.category = cat;
              }
            }
          }
        }
      }
    }
    accounts.push(acct);
  }
  return accounts;
}

async function main() {
  const accounts = await extractAccounts("/Users/Krownz/.sweep/stepper/kelly-report.html");
  // DEBUG — dump LVNV (Just Energy) per-bureau to see what compare-to-gold's extractor produces
  console.log(`\n  === LVNV (Just Energy) extracted by compare-to-gold's inline extractor ===`);
  for (const a of accounts) {
    if (!a.creditor.startsWith("LVNV FUNDING (Original Creditor: 10")) continue;
    for (const b of ["transunion", "experian", "equifax"] as const) {
      const det = a.bureaus[b];
      console.log(`     ${b}:  status=${JSON.stringify(det?.accountStatus ?? "")}  pmt=${JSON.stringify(det?.paymentStatus ?? "")}  fields=${det ? Object.keys((det as any).rawFields ?? {}).length : 0}`);
    }
  }
  const report: CreditReport = {
    platform: "iiq",
    reportDate: null,
    scores: { equifax: null, experian: null, transunion: null },
    summary: { equifax: {}, experian: {}, transunion: {} },
    accounts,
    inquiries: [],
    publicRecords: [],
    personalInfo: {} as PersonalInfo,
    warnings: [],
    errors: [],
  };
  const disp = listDisputables(report);
  console.log(`\n  ALL disputables (${disp.length}):`);
  disp.forEach((d) => console.log(`     ${d.bureau.padEnd(11)} ${d.category}  ${d.creditor}`));
  const sweepNames = Array.from(new Set(disp.map((d) => d.creditor)));
  const goldSet = new Set(GOLD.map(norm));
  const sweepSet = new Set(sweepNames.map(norm));

  console.log(`\n  Gold count: ${GOLD.length}`);
  console.log(`  Sweep auto-flagged unique creditors: ${sweepNames.length}`);
  console.log();
  console.log(`  ✓ MATCHES:`);
  for (const g of GOLD) {
    if (sweepSet.has(norm(g))) console.log(`     ${g}`);
  }
  console.log();
  console.log(`  ✗ MISSES (in gold, NOT flagged by Sweep):`);
  for (const g of GOLD) {
    if (!sweepSet.has(norm(g))) console.log(`     ${g}`);
  }
  console.log();
  console.log(`  ! EXTRAS (flagged by Sweep, NOT in gold):`);
  for (const s of sweepNames) {
    if (!goldSet.has(norm(s))) console.log(`     ${s}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
