import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;

// Find creditor headers — usually a line followed by "TransUnion\tExperian\tEquifax"
const headers = [...text.matchAll(/\n([A-Z][A-Z\s&/.\-]{2,40})\nTransUnion\s+Experian\s+Equifax/g)];
console.log(`Distinct account-header markers: ${headers.length}`);
headers.slice(0, 30).forEach((m, i) => console.log(`  ${i+1}. ${m[1].trim()}`));

// Also count "Two-Year payment history" mentions — one per account
const phCount = [...text.matchAll(/[Pp]ayment [Hh]istory\s+Legend/g)].length;
console.log(`\nPayment-history blocks: ${phCount}`);

// Count "30", "60", "90", "120" badges as late months
const late30 = (text.match(/\b30\b/g) || []).length;
const late60 = (text.match(/\b60\b/g) || []).length;
const late90 = (text.match(/\b90\b/g) || []).length;
const late120 = (text.match(/\b120\b/g) || []).length;
console.log(`\nNumeric late-month badge counts (rough): 30=${late30}  60=${late60}  90=${late90}  120=${late120}`);
