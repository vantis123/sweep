/**
 * Use pdfjs-dist to extract text WITH x-coordinates from the IIQ PDF.
 * Helps us map values to TU/EX/EQ columns when pdf-parse loses position info.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) { console.error("Usage: tsx inspect-pdf-positions.ts <pdf>"); process.exit(1); }
  const buf = readFileSync(pdfPath);
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  console.log(`Pages: ${doc.numPages}`);

  // Find a page that has the FAIRWAY VILLAGE account
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();
    const text = tc.items.map((it: any) => it.str).join("");
    if (!text.includes("FAIRWAY VILLAGE")) continue;
    console.log(`\n=== Page ${pageNum} has FAIRWAY VILLAGE ===`);
    const items = tc.items as Array<any>;
    // Show items with their x,y positions around FAIRWAY VILLAGE
    let printing = false;
    let count = 0;
    for (const it of items) {
      const t = it.str;
      if (t.includes("FAIRWAY VILLAGE") || printing) {
        printing = true;
        const x = it.transform[4];
        const y = it.transform[5];
        console.log(`  x=${x.toFixed(1).padStart(7)}  y=${y.toFixed(1).padStart(6)}  "${t}"`);
        count++;
        if (count >= 80) break;
      }
    }
    break;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
