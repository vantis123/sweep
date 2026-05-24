import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;
const positions = [...text.matchAll(/AFFIRM INC/g)].map(m => m.index!);
console.log(`AFFIRM INC count: ${positions.length}`);
for (let i = 0; i < Math.min(2, positions.length); i++) {
  console.log(`\n=== AFFIRM INC #${i + 1} ===`);
  console.log(text.slice(positions[i], positions[i] + 1400));
}
