import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;
// Find CBNA context — show what fields and history exist
const i = text.indexOf("CBNA");
if (i < 0) { console.log("CBNA not in PDF"); process.exit(0); }
console.log("=== CBNA section ===");
console.log(text.slice(i, i + 3000));
