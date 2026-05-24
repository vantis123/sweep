import { parseIIQ, isNegativeCategory, categorizeBureau, type Bureau } from "@sweep/parsers";
import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;
console.log(`PDF text length: ${text.length}`);

const report = parseIIQ(text);
console.log(`Accounts: ${report.accounts.length}`);
console.log(`Scores: TU=${report.scores.transunion} EX=${report.scores.experian} EQ=${report.scores.equifax}`);

const perBureau = { transunion: [], experian: [], equifax: [] } as Record<Bureau, any[]>;
for (const a of report.accounts) {
  for (const b of ["transunion", "experian", "equifax"] as Bureau[]) {
    const d = a.bureaus[b];
    if (!d) continue;
    const cat = categorizeBureau(d);
    if (!isNegativeCategory(cat)) continue;
    perBureau[b].push({ creditor: a.creditor, accountNumber: d.accountNumber, paymentStatus: d.paymentStatus, accountStatus: d.accountStatus, balance: d.balance, category: cat });
  }
}
for (const b of ["transunion", "experian", "equifax"] as Bureau[]) {
  console.log(`\n${b.toUpperCase()} negatives (${perBureau[b].length}):`);
  perBureau[b].forEach((n: any) => console.log(`  ${n.creditor.padEnd(20)} ${(n.accountNumber||"").padEnd(20)} ${n.paymentStatus || n.accountStatus}  → ${n.category}`));
}
