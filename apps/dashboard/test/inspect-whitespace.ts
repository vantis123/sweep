import { PDFParse } from "pdf-parse";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const parser = new PDFParse({ data: new Uint8Array(buf) });
const result = await parser.getText();
const text = result.text;
// Find FAIRWAY VILLAGE chunk
const i = text.indexOf("(Original Creditor: FAIRWAY VILLAGE)");
if (i < 0) { console.log("not found"); process.exit(0); }
// Show Account # line with raw character codes
const chunk = text.slice(i, i + 400);
const lines = chunk.split("\n");
for (const line of lines) {
  if (line.startsWith("Account #") || line.startsWith("Past Due") || line.startsWith("Balance:") || line.startsWith("Payment Status")) {
    // Show character codes
    const codes = Array.from(line).map((c, idx) => {
      const code = c.charCodeAt(0);
      return code === 9 ? "\\t" : code === 32 ? "·" : c;
    }).join("");
    console.log(`Raw: ${codes}`);
    console.log(`Len: ${line.length}`);
  }
}
