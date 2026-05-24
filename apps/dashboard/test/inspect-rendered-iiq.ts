import { extractIIQAccounts } from "@sweep/parsers";
import { readFileSync } from "node:fs";

const html = readFileSync("/Users/Krownz/.sweep/validate/iiq-rendered-jashard-nelson-1779588293029.html", "utf8");
console.log(`HTML size: ${html.length} chars`);

// Look for payment-history rendered text
const phMatch = html.match(/Payment History[\s\S]{0,3000}/i);
if (phMatch) {
  // Strip tags
  let ph = phMatch[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(`\n=== Payment History block (raw text, ~3000 chars) ===`);
  console.log(ph.slice(0, 1200));
}

// Check if ng-binding shows rendered data
console.log(`\nng-binding occurrences: ${(html.match(/ng-binding/g) || []).length}`);
console.log(`history.month references: ${(html.match(/history\.month/g) || []).length}`);
console.log(`history.tuc.name: ${(html.match(/history\.tuc\.name/g) || []).length}`);
console.log(`history.tuc.css: ${(html.match(/history\.tuc\.css/g) || []).length}`);

// extractIIQAccounts
const ext = extractIIQAccounts(html);
console.log(`\nAccounts found: ${ext.accounts.length}`);
console.log("First 10 creditors:");
ext.accounts.slice(0, 10).forEach((a, i) => console.log(`  ${i+1}. ${a.creditor}`));
