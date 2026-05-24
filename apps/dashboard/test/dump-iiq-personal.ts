import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";

const pdfPath = process.argv[2];
const buf = readFileSync(pdfPath);
const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
console.log(`Pages: ${doc.numPages}`);

// First 2 pages usually have personal info (Reports & Scores → Credit Report)
for (let p = 1; p <= Math.min(3, doc.numPages); p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  console.log(`\n=== PAGE ${p} ===`);
  for (const it of tc.items as any[]) {
    const text = (it.str ?? "").trim();
    if (!text) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    console.log(`  x=${x.toFixed(1).padStart(7)} y=${y.toFixed(1).padStart(6)}  "${text}"`);
  }
}
