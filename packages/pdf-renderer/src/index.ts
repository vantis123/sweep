/**
 * @sweep/pdf-renderer
 *
 *   renderLetterPdf({ html, fcra605bPath, breachImagePath, outputPath })
 *     1. Renders the affidavit HTML to PDF via Playwright.
 *     2. Merges the static FCRA §605B PDF after the affidavit.
 *     3. Adds the breach screenshot as a final page (image-on-letter).
 *     4. Writes one combined PDF to outputPath.
 */

import { chromium } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;
const PAGE_MARGIN_PT = 36;

export interface RenderLetterOptions {
  html: string;
  fcra605bPath: string;
  breachImagePath?: string;
  outputPath: string;
  /** When true, also writes the rendered HTML next to the PDF for debugging. */
  emitHtml?: boolean;
}

export async function renderLetterPdf(opts: RenderLetterOptions): Promise<void> {
  if (opts.emitHtml) {
    await writeFile(opts.outputPath.replace(/\.pdf$/i, ".html"), opts.html, "utf8");
  }

  const affidavitBytes = await htmlToPdfBytes(opts.html);

  const merged = await PDFDocument.create();

  await appendPdf(merged, affidavitBytes);

  if (existsSync(opts.fcra605bPath)) {
    const fcraBytes = await readFile(opts.fcra605bPath);
    await appendPdf(merged, new Uint8Array(fcraBytes));
  }

  if (opts.breachImagePath && existsSync(opts.breachImagePath)) {
    await appendImagePage(merged, opts.breachImagePath, "Evidence of Data Breach");
  }

  const out = await merged.save();
  await writeFile(opts.outputPath, out);
}

async function htmlToPdfBytes(html: string): Promise<Uint8Array> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "screen" });
    const buffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return new Uint8Array(buffer);
  } finally {
    await browser.close();
  }
}

async function appendPdf(target: PDFDocument, sourceBytes: Uint8Array): Promise<void> {
  const src = await PDFDocument.load(sourceBytes);
  const pages = await target.copyPages(src, src.getPageIndices());
  for (const p of pages) target.addPage(p);
}

async function appendImagePage(
  target: PDFDocument,
  imagePath: string,
  heading: string,
): Promise<void> {
  const ext = imagePath.split(".").pop()?.toLowerCase() ?? "png";
  const bytes = await readFile(imagePath);
  const img = ext === "jpg" || ext === "jpeg"
    ? await target.embedJpg(new Uint8Array(bytes))
    : await target.embedPng(new Uint8Array(bytes));

  const page = target.addPage([LETTER_WIDTH_PT, LETTER_HEIGHT_PT]);
  const font = await target.embedFont(StandardFonts.HelveticaBold);

  const titleY = LETTER_HEIGHT_PT - PAGE_MARGIN_PT - 20;
  page.drawText(heading, {
    x: PAGE_MARGIN_PT,
    y: titleY,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });

  const availableWidth = LETTER_WIDTH_PT - PAGE_MARGIN_PT * 2;
  const availableHeight = titleY - PAGE_MARGIN_PT - 20;
  const ratio = img.width / img.height;
  let drawWidth = availableWidth;
  let drawHeight = drawWidth / ratio;
  if (drawHeight > availableHeight) {
    drawHeight = availableHeight;
    drawWidth = drawHeight * ratio;
  }
  const drawX = (LETTER_WIDTH_PT - drawWidth) / 2;
  const drawY = PAGE_MARGIN_PT + (availableHeight - drawHeight) / 2;

  page.drawImage(img, { x: drawX, y: drawY, width: drawWidth, height: drawHeight });
}
