import { extractIIQAccounts } from "@sweep/parsers";
import { readFileSync } from "node:fs";

const html = readFileSync("/Users/Krownz/.sweep/validate/iiq-jashard-nelson-1779584592887.html", "utf8");
const extraction = extractIIQAccounts(html);
console.log(`Total accounts: ${extraction.accounts.length}\n`);

// Show ALL fields for accounts Drive flagged as late (Jashard's Round 13):
// DPT ED/AIDV, HUGHES FCU, DISCOVERCARD, AFFIRM INC, CBNA
const targets = ["DPT ED/AIDV", "HUGHES FCU", "DISCOVERCARD", "AFFIRM INC", "CBNA"];
for (const a of extraction.accounts) {
  if (!targets.some((t) => a.creditor.toUpperCase().includes(t))) continue;
  console.log(`\n=== ${a.creditor} ===`);
  console.log(`  perBureauNegative:`, a.perBureauNegative);
  for (const bureau of ["transunion", "experian", "equifax"] as const) {
    const d = a.perBureau[bureau];
    if (!d) continue;
    console.log(`  ${bureau}:`);
    for (const [k, v] of Object.entries(d)) {
      const vs = String(v).slice(0, 80);
      console.log(`    ${k.padEnd(28)} = ${vs}`);
    }
  }
}
