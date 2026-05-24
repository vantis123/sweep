import { extractIIQAccounts } from "@sweep/parsers";
import { readFileSync } from "node:fs";

const html = readFileSync("/Users/Krownz/.sweep/validate/iiq-scadia-fuller-1779564590355.html", "utf8");
const ext = extractIIQAccounts(html);
console.log(`Total accounts: ${ext.accounts.length}`);

// Show full fields for CAPITAL ONE and CREDITONEBNK
for (const a of ext.accounts) {
  if (!/CAPITAL ONE|CREDITONEBNK|SELF/i.test(a.creditor)) continue;
  console.log(`\n=== ${a.creditor} ===`);
  console.log(`  perBureauNegative:`, a.perBureauNegative);
  for (const b of ["transunion", "experian", "equifax"] as const) {
    const d = a.perBureau[b];
    if (!d) continue;
    console.log(`  ${b}:`);
    for (const k of ["Account Status", "Payment Status", "Past Due", "Comments", "Account Type - Detail", "Balance"]) {
      if (d[k]) console.log(`    ${k.padEnd(22)} = ${d[k]}`);
    }
  }
}
