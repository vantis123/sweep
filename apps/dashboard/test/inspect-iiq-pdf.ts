import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
// Print sections of interest
const text = result.text;
console.log(`Total PDF text: ${text.length} chars`);
console.log(`Has "Payment History": ${text.includes("Payment History") || text.includes("payment history")}`);
console.log(`Has month names: ${["Jan","Feb","Mar","Apr"].filter(m => text.includes(m)).join(",")}`);
console.log(`Has account "DPT ED": ${text.includes("DPT ED")}`);
console.log(`Has account "DISCOVERCARD": ${text.includes("DISCOVERCARD")}`);

// Search for any 2-year-history-like row
const phMatch = text.search(/payment history/i);
if (phMatch > 0) {
  console.log(`\n=== Around 'payment history' (offset ${phMatch}) ===`);
  console.log(text.slice(phMatch, phMatch + 1500));
}

// Total accounts found
const credPattern = /\n([A-Z]{4,}[A-Z\s/&]*?)\n.+?Account #/g;
const matches = [...text.matchAll(credPattern)].slice(0, 20);
console.log(`\nFirst 20 creditor-like names found in PDF:`);
matches.forEach((m, i) => console.log(`  ${i+1}. ${m[1].trim()}`));
