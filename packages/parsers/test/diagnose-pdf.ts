import { readFile, writeFile } from "node:fs/promises";
import { parseFSNAny } from "@sweep/parsers";
import { PDFParse } from "pdf-parse";

const pdfPath = process.argv[2] || "/Users/Krownz/.bank/sandbox/fsn-print-download-1778283605996.pdf";
const buf = await readFile(pdfPath);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
await parser.destroy();
const text = Array.isArray(result.pages)
  ? result.pages.map((p: any) => p.text ?? "").join("\n\n")
  : (result as any).text ?? "";

console.log(`PDF: ${pdfPath}`);
console.log(`Text length: ${text.length} chars`);
await writeFile("/tmp/jeffrey-pdf-text.txt", text);
console.log(`Saved to /tmp/jeffrey-pdf-text.txt`);
console.log(`\n--- first 800 ---\n${text.slice(0, 800)}\n---`);

const report = parseFSNAny(text);
console.log(`\n--- parser ---`);
console.log(`platform: ${report.platform}`);
console.log(`scores: EQ=${report.scores.equifax} EX=${report.scores.experian} TU=${report.scores.transunion}`);
console.log(`accounts: ${report.accounts.length}`);
console.log(`negative: ${report.accounts.filter(a => a.isNegative).length}`);
console.log(`warnings: ${report.warnings.join(' | ')}`);
console.log(`\n--- categories ---`);
const cats: Record<string, number> = {};
for (const a of report.accounts) cats[a.category] = (cats[a.category] ?? 0) + 1;
console.log(cats);
console.log(`\n--- top 10 negatives ---`);
const negs = report.accounts.filter(a => a.isNegative).slice(0, 10);
for (const a of negs) console.log(`  · ${a.creditor.padEnd(30)} cat=${a.category}`);
