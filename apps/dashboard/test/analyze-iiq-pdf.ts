/**
 * Standalone PDF analyzer for saved IIQ rendered PDFs. Uses pdfjs-dist so we
 * have positional info — that's how we map values to TU/EX/EQ columns even
 * when some columns are empty (collections that only report on one bureau).
 *
 *   npx tsx apps/dashboard/test/analyze-iiq-pdf.ts <pdfPath>
 *
 * If no path is given, uses the most-recent PDF in ~/.sweep/validate/.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

type Bureau = "transunion" | "experian" | "equifax";
const bureauKeys: Bureau[] = ["transunion", "experian", "equifax"];

interface TextItem {
  text: string;
  x: number;
  y: number;
  page: number;
}

interface ParsedAccount {
  creditor: string;
  perBureau: Record<Bureau, {
    fields: Record<string, string>;
    historyWorstLate: number;
    hasData: boolean;
  }>;
}

function findLatestPdf(): string {
  const dir = resolve(homedir(), ".sweep", "validate");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("iiq-rendered-") && f.endsWith(".pdf"))
    .map((f) => ({ name: f, path: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`No iiq-rendered-*.pdf in ${dir}`);
  return files[0].path;
}

function classifyNegative(blob: string): string | null {
  if (/charge.?off/i.test(blob)) return "chargeoff";
  if (/collection/i.test(blob)) return "collection";
  if (/repossess/i.test(blob)) return "repossession";
  if (/foreclosure/i.test(blob)) return "foreclosure";
  if (/bankrupt/i.test(blob)) return "bankruptcy";
  if (/derogatory/i.test(blob)) return "derogatory";
  const m = blob.match(/late\s*(\d+)/i);
  if (m) return `late${m[1]}`;
  if (/past\s*due/i.test(blob)) return "past_due";
  return null;
}

async function extractTextItems(pdfPath: string): Promise<TextItem[]> {
  const buf = readFileSync(pdfPath);
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const items: TextItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items as any[]) {
      const text = (it.str ?? "").trim();
      if (!text) continue;
      items.push({
        text,
        x: it.transform[4],
        y: it.transform[5],
        page: p,
      });
    }
  }
  return items;
}

/**
 * Group items into per-line clusters based on y-coordinate (same page).
 * Returns items sorted top-down, left-right within each line.
 */
function groupByLines(items: TextItem[]): TextItem[][] {
  // Sort by page asc, y desc (PDF y grows upward), x asc
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
    return a.x - b.x;
  });
  const lines: TextItem[][] = [];
  let cur: TextItem[] = [];
  let lastY: number | null = null;
  let lastPage: number | null = null;
  for (const it of sorted) {
    if (lastPage !== it.page || lastY === null || Math.abs(it.y - lastY) > 3) {
      if (cur.length > 0) lines.push(cur);
      cur = [];
    }
    cur.push(it);
    lastY = it.y;
    lastPage = it.page;
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

/** Assign an x-coordinate to a bureau based on the column header positions. */
function bureauFromX(x: number, cols: { tu: number; ex: number; eq: number }): Bureau {
  const candidates: Array<{ bureau: Bureau; d: number }> = [
    { bureau: "transunion", d: Math.abs(x - cols.tu) },
    { bureau: "experian", d: Math.abs(x - cols.ex) },
    { bureau: "equifax", d: Math.abs(x - cols.eq) },
  ];
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0].bureau;
}

/** Find the column-header x-positions for each bureau across the document. */
function findBureauColumns(lines: TextItem[][]): { tu: number; ex: number; eq: number } {
  // Look for the typical "TransUnion ... Experian ... Equifax" header line.
  for (const line of lines) {
    const tu = line.find((it) => /^TransUnion$/i.test(it.text));
    const ex = line.find((it) => /^Experian$/i.test(it.text));
    const eq = line.find((it) => /^Equifax$/i.test(it.text));
    if (tu && ex && eq) return { tu: tu.x, ex: ex.x, eq: eq.x };
  }
  // Fallback to common defaults (matches the IIQ print layout we've seen)
  return { tu: 170, ex: 283, eq: 394 };
}

/** Split lines into per-account chunks. Each chunk starts at the creditor line
 *  immediately preceding the "TransUnion Experian Equifax" header. */
function chunkByAccount(lines: TextItem[][]): TextItem[][][] {
  const accounts: TextItem[][][] = [];
  let current: TextItem[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.map((it) => it.text).join(" ");
    // Detect bureau header line ("TransUnion" + "Experian" + "Equifax" present, in that order)
    const hasTu = /\bTransUnion\b/.test(text);
    const hasEx = /\bExperian\b/.test(text);
    const hasEq = /\bEquifax\b/.test(text);
    const isBureauHeader = hasTu && hasEx && hasEq && line.length >= 3 && line.length <= 8;
    if (isBureauHeader && i > 0) {
      const prevLine = lines[i - 1];
      const prevText = prevLine.map((it) => it.text).join(" ").trim();
      // Skip if prev line looks like a field row (contains ":") or is empty
      if (prevText && !/:$/.test(prevText.trim()) && !/^\s*Two-Year/i.test(prevText)) {
        // Start a new account chunk from the previous line
        if (current.length > 1) accounts.push(current.slice(0, -1));
        current = [prevLine, line];
        continue;
      }
    }
    current.push(line);
  }
  if (current.length > 0) accounts.push(current);
  return accounts;
}

async function parsePdf(pdfPath: string): Promise<ParsedAccount[]> {
  const items = await extractTextItems(pdfPath);
  const lines = groupByLines(items);
  const cols = findBureauColumns(lines);
  const accountChunks = chunkByAccount(lines);
  const out: ParsedAccount[] = [];

  for (const chunk of accountChunks) {
    if (chunk.length < 3) continue;
    const credLine = chunk[0];
    const headerLine = chunk[1];
    const creditor = credLine.map((it) => it.text).join(" ").replace(/\s+/g, " ").trim();
    if (!creditor || /^Account #/i.test(creditor)) continue;

    const headerText = headerLine.map((it) => it.text).join(" ");
    if (!/TransUnion/i.test(headerText) || !/Experian/i.test(headerText) || !/Equifax/i.test(headerText)) {
      continue;
    }

    const perBureau = {
      transunion: { fields: {} as Record<string, string>, historyWorstLate: 0, hasData: false },
      experian: { fields: {} as Record<string, string>, historyWorstLate: 0, hasData: false },
      equifax: { fields: {} as Record<string, string>, historyWorstLate: 0, hasData: false },
    };

    // Walk subsequent lines until we hit the bureau header of the NEXT account
    // (already handled by chunkByAccount cutting). Inside the chunk:
    //   - Field rows: first item is "Label:" — remaining items are per-bureau values
    //   - Payment history block: "Two-Year payment history" + 3 bureau rows
    let inHistory = false;
    for (let li = 2; li < chunk.length; li++) {
      const line = chunk[li];
      const lineText = line.map((it) => it.text).join(" ");

      if (/Two-Year payment history/i.test(lineText)) {
        inHistory = true;
        continue;
      }
      if (inHistory) {
        // Find the bureau name in this line. Position of the bureau-name item
        // is column 1 (label); subsequent items are status badges.
        const bureauItem = line.find((it) => /^(TransUnion|Experian|Equifax)$/i.test(it.text));
        if (!bureauItem) continue;
        const bureau = bureauItem.text.toLowerCase() as Bureau;
        let worst = 0;
        for (const it of line) {
          if (it === bureauItem) continue;
          // Status badges are 30/60/90/120/150/180
          if (!/^\d+$/.test(it.text)) continue;
          const n = parseInt(it.text, 10);
          if (n === 30 || n === 60 || n === 90 || n === 120 || n === 150 || n === 180) {
            if (n > worst) worst = n;
          }
        }
        perBureau[bureau].historyWorstLate = worst;
        continue;
      }

      // Field row — first item should be label (ends in ":")
      const labelItem = line.find((it) => /:$/.test(it.text));
      if (!labelItem) continue;
      const labelIdx = line.indexOf(labelItem);
      const label = labelItem.text.replace(/:$/, "").trim();
      if (label.length > 35) continue;
      // Subsequent items are values — assign to bureau by x-coordinate
      for (let i = labelIdx + 1; i < line.length; i++) {
        const it = line[i];
        const text = it.text.trim();
        if (!text || text === "-") continue;
        // Skip column separators (just whitespace)
        if (text === "" || text.length === 0) continue;
        const bureau = bureauFromX(it.x, cols);
        // Only keep "real" values — skip the placeholder " "
        if (!perBureau[bureau].fields[label]) {
          perBureau[bureau].fields[label] = text;
        }
      }
    }

    // hasData: bureau has account if Account # is set (or any field is set)
    for (const b of bureauKeys) {
      const f = perBureau[b].fields;
      perBureau[b].hasData =
        !!(f["Account #"] || f["Account Number"] || Object.keys(f).length > 0);
    }

    out.push({ creditor, perBureau });
  }
  return out;
}

async function main() {
  const pdfPath = process.argv[2] || findLatestPdf();
  console.log(`PDF: ${pdfPath}\n`);
  const accounts = await parsePdf(pdfPath);
  console.log(`Total accounts parsed: ${accounts.length}\n`);

  const negatives: Record<Bureau, Array<{ creditor: string; acct: string; reason: string }>> = {
    transunion: [], experian: [], equifax: [],
  };
  for (const a of accounts) {
    const statusByBureau: Record<Bureau, string | null> = { transunion: null, experian: null, equifax: null };
    for (const b of bureauKeys) {
      if (!a.perBureau[b].hasData) continue;
      const f = a.perBureau[b].fields;
      const blob = `${f["Account Type"] ?? ""} ${f["Account Status"] ?? ""} ${f["Payment Status"] ?? ""} ${f["Comments"] ?? ""}`;
      statusByBureau[b] = classifyNegative(blob);
    }
    const allComments = bureauKeys
      .map((b) => (a.perBureau[b].fields["Comments"] ?? "").toLowerCase())
      .join(" ");
    if (/(deferred|in deferment|forbearance)/.test(allComments)) continue;

    const anyStatus = Object.values(statusByBureau).some((c) => c !== null);
    const anyHist = bureauKeys.some((b) => a.perBureau[b].historyWorstLate > 0);
    if (!anyStatus && !anyHist) continue;

    let propagated: string | null = null;
    for (const c of Object.values(statusByBureau)) if (c) { propagated = c; break; }
    const worstHistAny = Math.max(...bureauKeys.map((b) => a.perBureau[b].historyWorstLate));

    for (const b of bureauKeys) {
      if (!a.perBureau[b].hasData) continue;
      let reason: string;
      if (statusByBureau[b]) reason = statusByBureau[b]!;
      else if (a.perBureau[b].historyWorstLate > 0) reason = `late${a.perBureau[b].historyWorstLate}`;
      else if (propagated) reason = propagated;
      else if (worstHistAny > 0) reason = `late${worstHistAny}`;
      else continue;
      const f = a.perBureau[b].fields;
      negatives[b].push({ creditor: a.creditor, acct: f["Account #"] ?? "?", reason });
    }
  }

  for (const b of bureauKeys) {
    console.log(`=== ${b.toUpperCase()} (${negatives[b].length}) ===`);
    for (const n of negatives[b]) {
      console.log(`  ${n.creditor.padEnd(40)} ${n.acct.padEnd(20)} ${n.reason}`);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
