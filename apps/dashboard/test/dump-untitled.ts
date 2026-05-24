import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;
for (const needle of ["Untitled Collection", "FAIRWAY VILLAGE", "Original Creditor"]) {
  const i = text.indexOf(needle);
  if (i < 0) { console.log(`'${needle}' NOT FOUND`); continue; }
  console.log(`\n=== '${needle}' at ${i} ===`);
  console.log(text.slice(Math.max(0, i - 80), i + 400));
}
