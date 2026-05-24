import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;
for (const needle of ["5246", "Original Creditor", "FAIRWAY", "Collection"]) {
  const positions = [];
  let i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) { positions.push(i); i++; if (positions.length >= 3) break; }
  console.log(`\n=== '${needle}' (${positions.length} occurrences) ===`);
  for (const p of positions) {
    console.log(`-- at ${p} --`);
    console.log(text.slice(Math.max(0, p - 100), p + 250));
    console.log();
  }
}
