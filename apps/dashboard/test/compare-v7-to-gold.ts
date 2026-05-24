/**
 * Compare v7 per-bureau disputes against Phillip's deletion report.
 * Matches by account number prefix (handles bureau-specific name variants).
 */

import { readFile } from "node:fs/promises";

// Gold list with the expected account numbers and the canonical name Phillip uses
const GOLD: Record<string, Array<{ name: string; acctPrefix: string }>> = {
  experian: [
    { name: "LVNV FUNDING (Original Creditor: 10 JUST ENERGY TEXAS LP)", acctPrefix: "77120" },
    { name: "MIDLAND CRED (Original Creditor: 01 CREDIT ONE BANK N A)", acctPrefix: "33052" },
    { name: "I C SYSTEM (Original Creditor: 11 CHARTER COMMUNICATIONS)", acctPrefix: "17692" },
    { name: "SPRINGOAKCAP (Original Creditor: 12 CELTIC BANK)", acctPrefix: "11214" },
    { name: "LVNV FUNDING (Original Creditor: 12 FIRST DIGITAL FDC SYNOVUS BANK)", acctPrefix: "526449020550" },
    { name: "PRO COLLECT (Original Creditor: 09 THE FELIX APARTMENTS S2)", acctPrefix: "57424001250" },
    { name: "SUNRISECRED (Original Creditor: 11 AT T MOBILITY)", acctPrefix: "17707334" },
    { name: "TRANSWORLD (Original Creditor: 10 4CHANGE ENERGY COMPANY)", acctPrefix: "3083" },
    { name: "STAFFORD GRP (Original Creditor: 12 GREENWAVE FINANCE LLC)", acctPrefix: "1965" },
    { name: "CAINE & WEINER (Original Creditor: PROGRESSIVE)", acctPrefix: "1985" },
    { name: "SYN/FIRSTDIG", acctPrefix: "52644902" },
    { name: "MDG US INC", acctPrefix: "584" },
    { name: "CONN'S SERV", acctPrefix: "49857" },
    { name: "RESOURCE ONE", acctPrefix: "48970902" },
  ],
  equifax: [
    { name: "LVNV FUNDING (Original Creditor: 10 JUST ENERGY TEXAS LP)", acctPrefix: "77120" },
    { name: "MIDLAND CRED (Original Creditor: 01 CREDIT ONE BANK N A)", acctPrefix: "33052" },
    { name: "I C SYSTEM (Original Creditor: 11 CHARTER COMMUNICATIONS)", acctPrefix: "17692" },
    { name: "CREDIT COLL (Original Creditor: 06 THE GENERAL INSURANCE COMPANY)", acctPrefix: "1713" },
    { name: "SPRINGOAKCAP (Original Creditor: 12 CELTIC BANK)", acctPrefix: "11214" },
    { name: "LVNV FUNDING (Original Creditor: 12 FIRST DIGITAL FDC SYNOVUS BANK)", acctPrefix: "526449020550" },
    { name: "PRO COLLECT (Original Creditor: 09 THE FELIX APARTMENTS S2)", acctPrefix: "57424001250" },
    { name: "SUNRISECRED (Original Creditor: 11 AT T MOBILITY)", acctPrefix: "17707334" },
    { name: "CAINE & WEINER (Original Creditor: PROGRESSIVE)", acctPrefix: "1985" },
    { name: "SYN/FIRSTDIG", acctPrefix: "52644902" },
    { name: "MDG US INC", acctPrefix: "58489" },
    { name: "CONN'S SERV", acctPrefix: "49857" },
    { name: "RESOURCE ONE", acctPrefix: "48970902" },
  ],
  transunion: [
    { name: "LVNV FUNDING (Original Creditor: 10 JUST ENERGY TEXAS LP)", acctPrefix: "77120" },
    { name: "MIDLAND CRED (Original Creditor: 01 CREDIT ONE BANK N A)", acctPrefix: "33052" },
    { name: "I C SYSTEM (Original Creditor: 11 CHARTER COMMUNICATIONS)", acctPrefix: "17692" },
    { name: "CREDIT COLL (Original Creditor: 06 THE GENERAL INSURANCE COMPANY)", acctPrefix: "1713" },
    { name: "SPRINGOAKCAP (Original Creditor: 12 CELTIC BANK)", acctPrefix: "11214" },
    { name: "LVNV FUNDING (Original Creditor: 12 FIRST DIGITAL FDC SYNOVUS BANK)", acctPrefix: "526449020550" },
    { name: "PRO COLLECT (Original Creditor: 09 THE FELIX APARTMENTS S2)", acctPrefix: "57424001250" },
    { name: "SUNRISECRED (Original Creditor: 11 AT T MOBILITY)", acctPrefix: "17707334" },
    { name: "TRANSWORLD (Original Creditor: 10 4CHANGE ENERGY COMPANY)", acctPrefix: "3083" },
    { name: "STAFFORD GRP (Original Creditor: 12 GREENWAVE FINANCE LLC)", acctPrefix: "1965" },
    { name: "SYN/FIRSTDIG", acctPrefix: "52644902" },
    { name: "CONN'S SERV", acctPrefix: "49857" },
    { name: "RESOURCE ONE", acctPrefix: "48970902" },
  ],
};

const normAcct = (s: string) => (s || "").replace(/[*\s]/g, "");

async function main() {
  const v7 = JSON.parse(await readFile("/Users/Krownz/.sweep/stepper/kelly-report-accounts-v7.json", "utf8"));
  for (const bureau of ["experian", "equifax", "transunion"] as const) {
    const gold = GOLD[bureau]!;
    const items = v7.accounts.filter((a: any) => a.perBureauNegative[bureau].negative);
    const v7AcctPrefixes = items.map((a: any) => normAcct(a.perBureau[bureau]["Account #"] || ""));

    console.log(`\n========== ${bureau.toUpperCase()} ==========`);
    console.log(`  Gold: ${gold.length}   v7: ${items.length}`);

    console.log(`\n  ✓ MATCHED:`);
    let matched = 0;
    for (const g of gold) {
      const hit = v7AcctPrefixes.find((p: string) => p.startsWith(g.acctPrefix) || g.acctPrefix.startsWith(p.slice(0, 6)));
      if (hit) {
        const item = items.find((a: any) => normAcct(a.perBureau[bureau]["Account #"] || "") === hit);
        console.log(`     ✓  Gold: ${g.name}  →  IIQ: ${item.creditor}`);
        matched++;
      }
    }

    console.log(`\n  ✗ GOLD MISSES (in your list, not flagged by v7):`);
    let misses = 0;
    for (const g of gold) {
      const hit = v7AcctPrefixes.find((p: string) => p.startsWith(g.acctPrefix) || g.acctPrefix.startsWith(p.slice(0, 6)));
      if (!hit) { console.log(`     ✗  ${g.name}  (acct ${g.acctPrefix}****)`); misses++; }
    }
    if (misses === 0) console.log(`     (none)`);

    console.log(`\n  ! V7 EXTRAS (flagged but not in your gold list):`);
    let extras = 0;
    for (const item of items) {
      const acctPrefix = normAcct(item.perBureau[bureau]["Account #"] || "");
      const inGold = gold.find((g) => acctPrefix.startsWith(g.acctPrefix) || g.acctPrefix.startsWith(acctPrefix.slice(0, 6)));
      if (!inGold) {
        const d = item.perBureau[bureau];
        console.log(`     !  ${item.creditor}  [${d["Account #"]} · ${d["Date Opened"]} · ${d["Balance"]}]`);
        extras++;
      }
    }
    if (extras === 0) console.log(`     (none)`);

    console.log(`\n  Summary: ${matched}/${gold.length} matched, ${misses} miss, ${extras} extra`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
