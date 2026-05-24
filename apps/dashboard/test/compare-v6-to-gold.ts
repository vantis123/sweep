/**
 * Compare v6 per-bureau disputes against Phillip's Client File / Deletion Report.
 *
 *   npx tsx apps/dashboard/test/compare-v6-to-gold.ts
 */

import { readFile } from "node:fs/promises";

const GOLD: Record<string, string[]> = {
  experian: [
    "LVNV FUNDING (Original Creditor: 10 JUST ENERGY TEXAS LP)",
    "MIDLAND CRED (Original Creditor: 01 CREDIT ONE BANK N A)",
    "I C SYSTEM (Original Creditor: 11 CHARTER COMMUNICATIONS)",
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
  ],
  equifax: [
    "LVNV FUNDING (Original Creditor: 10 JUST ENERGY TEXAS LP)",
    "MIDLAND CRED (Original Creditor: 01 CREDIT ONE BANK N A)",
    "I C SYSTEM (Original Creditor: 11 CHARTER COMMUNICATIONS)",
    "CREDIT COLL (Original Creditor: 06 THE GENERAL INSURANCE COMPANY)",
    "SPRINGOAKCAP (Original Creditor: 12 CELTIC BANK)",
    "LVNV FUNDING (Original Creditor: 12 FIRST DIGITAL FDC SYNOVUS BANK)",
    "PRO COLLECT (Original Creditor: 09 THE FELIX APARTMENTS S2)",
    "SUNRISECRED (Original Creditor: 11 AT T MOBILITY)",
    "CAINE & WEINER (Original Creditor: PROGRESSIVE)",
    "SYN/FIRSTDIG",
    "MDG US INC",
    "CONN'S SERV",
    "RESOURCE ONE",
  ],
  transunion: [
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
    "SYN/FIRSTDIG",
    "CONN'S SERV",
    "RESOURCE ONE",
  ],
};

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

async function main() {
  const path = "/Users/Krownz/.sweep/stepper/kelly-report-listings-v6.json";
  const v6 = JSON.parse(await readFile(path, "utf8"));

  for (const bureau of ["experian", "equifax", "transunion"] as const) {
    const gold = GOLD[bureau]!;
    const goldSet = new Set(gold.map(norm));
    const v6Items = v6.disputes.filter((d: any) => d.bureau === bureau);
    const v6Names = v6Items.map((d: any) => d.creditor);
    const v6Set = new Set(v6Names.map(norm));

    console.log(`\n========================= ${bureau.toUpperCase()} =========================`);
    console.log(`  Gold count: ${gold.length}   v6 count: ${v6Items.length} (with duplicate listings)`);
    console.log(`  v6 unique creditor names: ${new Set(v6Names).size}`);

    console.log(`\n  ✓ GOLD ITEMS THAT V6 FOUND:`);
    for (const g of gold) {
      if (v6Set.has(norm(g))) console.log(`     ✓  ${g}`);
    }

    console.log(`\n  ✗ GOLD ITEMS V6 IS MISSING:`);
    let missing = 0;
    for (const g of gold) {
      if (!v6Set.has(norm(g))) { console.log(`     ✗  ${g}`); missing++; }
    }
    if (missing === 0) console.log(`     (none — perfect coverage of gold)`);

    console.log(`\n  ! EXTRAS V6 INCLUDED (not on your dispute list):`);
    let extras = 0;
    const seenExtras = new Set<string>();
    for (const item of v6Items) {
      const n = norm(item.creditor);
      if (!goldSet.has(n) && !seenExtras.has(n)) {
        console.log(`     !  ${item.creditor}  [${item.detail}]`);
        seenExtras.add(n);
        extras++;
      }
    }
    if (extras === 0) console.log(`     (none)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
