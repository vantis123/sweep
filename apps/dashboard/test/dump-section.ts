import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;
const needle = process.argv[3];
const i = text.indexOf(needle);
if (i < 0) { console.log(`'${needle}' not found`); process.exit(0); }
console.log(text.slice(i, i + 2500));
