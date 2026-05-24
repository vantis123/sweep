import { parseFSN3B, type Bureau } from "@sweep/parsers";
import { readFileSync } from "node:fs";

const html = readFileSync("/tmp/sweep-validation/fsn-html-shaun-bailer.html", "utf8");
const report = parseFSN3B(html);

// Show ALL fields for THD/CBNA, MARINR FINC, and one TD BANK for comparison
for (const a of report.accounts) {
  if (!["THD/CBNA", "MARINR FINC", "TD BANK N.A."].includes(a.creditor)) continue;
  console.log(`\n=== ${a.creditor} ===`);
  for (const b of ["transunion", "experian", "equifax"] as Bureau[]) {
    const d = a.bureaus[b];
    if (!d) continue;
    console.log(`  ${b}:`);
    for (const [k, v] of Object.entries(d)) {
      if (k === "rawFields") {
        console.log(`    rawFields:`);
        for (const [rk, rv] of Object.entries(v as Record<string, string>)) {
          console.log(`      ${rk}: ${rv}`);
        }
      } else {
        console.log(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
}
