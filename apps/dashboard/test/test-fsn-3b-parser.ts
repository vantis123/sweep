import { parseFSN3B, looksLikeFSN3B } from "@sweep/parsers";
import { isNegativeCategory, categorizeBureau, type Bureau } from "@sweep/parsers";
import { readFileSync } from "node:fs";

const html = readFileSync("/tmp/sweep-validation/fsn-html-shaun-bailer.html", "utf8");
console.log(`HTML length: ${html.length} chars`);
console.log(`looksLikeFSN3B: ${looksLikeFSN3B(html)}`);

if (!looksLikeFSN3B(html)) process.exit(1);

const report = parseFSN3B(html);
console.log(`\nTotal accounts: ${report.accounts.length}`);
console.log(`Report date: ${report.reportDate}`);
console.log(`Scores: TU=${report.scores.transunion} EX=${report.scores.experian} EQ=${report.scores.equifax}`);

const negativesByBureau: Record<Bureau, any[]> = { transunion: [], experian: [], equifax: [] };
for (const a of report.accounts) {
  for (const b of ["transunion", "experian", "equifax"] as Bureau[]) {
    const d = a.bureaus[b];
    if (!d) continue;
    const cat = categorizeBureau(d);
    if (!isNegativeCategory(cat)) continue;
    negativesByBureau[b].push({ creditor: a.creditor, accountNumber: d.accountNumber, balance: d.balance, paymentStatus: d.paymentStatus, accountStatus: d.accountStatus, category: cat });
  }
}

console.log(`\n=== TransUnion negatives (${negativesByBureau.transunion.length}) ===`);
negativesByBureau.transunion.forEach(n => console.log(`  ${n.creditor.padEnd(20)} ${(n.accountNumber||"").padEnd(20)} $${n.balance ?? "?"}  ${n.paymentStatus || n.accountStatus}  → ${n.category}`));
console.log(`\n=== Experian negatives (${negativesByBureau.experian.length}) ===`);
negativesByBureau.experian.forEach(n => console.log(`  ${n.creditor.padEnd(20)} ${(n.accountNumber||"").padEnd(20)} $${n.balance ?? "?"}  ${n.paymentStatus || n.accountStatus}  → ${n.category}`));
console.log(`\n=== Equifax negatives (${negativesByBureau.equifax.length}) ===`);
negativesByBureau.equifax.forEach(n => console.log(`  ${n.creditor.padEnd(20)} ${(n.accountNumber||"").padEnd(20)} $${n.balance ?? "?"}  ${n.paymentStatus || n.accountStatus}  → ${n.category}`));

console.log(`\n=== ALL accounts seen ===`);
report.accounts.forEach(a => console.log(`  ${a.creditor.padEnd(20)} category=${a.category}  negative=${a.isNegative}  bureaus=[${Object.keys(a.bureaus).join(",")}]`));
