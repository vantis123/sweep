import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync } from "node:fs";
const pdfPath = process.argv[2];
const buf = readFileSync(pdfPath);
const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const text = tc.items.map((it: any) => it.str).join(" ");
  if (!/CREDITONEBNK/.test(text)) continue;
  const items = tc.items as any[];
  let printing = false;
  let count = 0;
  for (const it of items) {
    if (it.str.includes("CREDITONEBNK")) printing = true;
    if (!printing) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    console.log(`  page${p} x=${x.toFixed(1).padStart(7)} y=${y.toFixed(1).padStart(6)}  "${it.str}"`);
    count++;
    if (count >= 35) { count = 0; printing = false; }
  }
}
