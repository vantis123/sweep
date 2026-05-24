import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";

const pdfPath = process.argv[2];
const buf = readFileSync(pdfPath);
const doc = await getDocument({ data: new Uint8Array(buf) }).promise;

for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const text = tc.items.map((it: any) => it.str).join(" ");
  if (!text.includes("Original Creditor: FAIRWAY VILLAGE")) continue;
  console.log(`\n=== Page ${pageNum} has the FAIRWAY VILLAGE account block ===`);
  const items = tc.items as Array<any>;
  let printing = false;
  let count = 0;
  for (const it of items) {
    if (it.str.includes("FAIRWAY VILLAGE")) printing = true;
    if (!printing) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    console.log(`  x=${x.toFixed(1).padStart(7)}  y=${y.toFixed(1).padStart(6)}  "${it.str}"`);
    count++;
    if (count >= 60) break;
  }
  break;
}
