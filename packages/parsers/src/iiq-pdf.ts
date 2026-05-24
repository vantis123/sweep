/**
 * IIQ PDF parser using pdfjs-dist for positional text extraction.
 *
 * Why positional parsing: the IIQ report has 3 bureau columns (TU/EX/EQ).
 * pdf-parse extracts text in reading order but collapses whitespace, so we
 * lose which column a value sits in when other columns are empty (e.g.,
 * single-bureau collection accounts). pdfjs-dist preserves x-coordinates,
 * so we can map every value to the correct bureau by x-position relative
 * to the column headers.
 *
 * Input: PDF buffer (from page.pdf() rendering of IIQ's CreditReport.aspx
 * page after clicking "Print this page").
 *
 * Output: IIQPdfReport with per-account, per-bureau data + payment-history
 * worst-late detection. Downstream code applies the negative-detection rules.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type IIQPdfBureau = "transunion" | "experian" | "equifax";
const BUREAUS: IIQPdfBureau[] = ["transunion", "experian", "equifax"];

export interface IIQPdfBureauDetail {
  fields: Record<string, string>;
  historyWorstLate: number; // 0/30/60/90/120/150/180
  hasData: boolean;
}

export interface IIQPdfAccount {
  creditor: string;
  perBureau: Record<IIQPdfBureau, IIQPdfBureauDetail>;
}

/** Personal-info fields extracted from the top "Personal Information" section.
 *  Pre-resolved across bureaus (longest non-empty value wins per field). */
export interface IIQPdfPersonalInfo {
  fullName: string;
  dateOfBirth: string;
  street: string;
  cityStateZip: string;
}

export interface IIQPdfReport {
  accounts: IIQPdfAccount[];
  personalInfo: IIQPdfPersonalInfo;
}

interface TI {
  text: string;
  x: number;
  y: number;
  page: number;
}

export async function parseIIQPdf(pdfBuffer: Uint8Array): Promise<IIQPdfReport> {
  const doc = await getDocument({ data: pdfBuffer }).promise;
  const items: TI[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items as any[]) {
      const text = (it.str ?? "").trim();
      if (!text) continue;
      items.push({ text, x: it.transform[4], y: it.transform[5], page: p });
    }
  }

  // Group items into lines (same page, similar y).
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
    return a.x - b.x;
  });
  const lines: TI[][] = [];
  let cur: TI[] = [];
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

  // Find bureau column x-positions from the header line.
  let cols = { tu: 170, ex: 283, eq: 394 };
  for (const line of lines) {
    const tu = line.find((it) => /^TransUnion$/i.test(it.text));
    const ex = line.find((it) => /^Experian$/i.test(it.text));
    const eq = line.find((it) => /^Equifax$/i.test(it.text));
    if (tu && ex && eq) {
      cols = { tu: tu.x, ex: ex.x, eq: eq.x };
      break;
    }
  }

  const bureauFromX = (x: number): IIQPdfBureau => {
    const d = [
      { b: "transunion" as IIQPdfBureau, v: Math.abs(x - cols.tu) },
      { b: "experian" as IIQPdfBureau, v: Math.abs(x - cols.ex) },
      { b: "equifax" as IIQPdfBureau, v: Math.abs(x - cols.eq) },
    ];
    d.sort((a, b) => a.v - b.v);
    return d[0]!.b;
  };

  // Chunk lines by account. An account starts at the creditor-name line
  // immediately preceding the "TransUnion Experian Equifax" header.
  const accountChunks: TI[][][] = [];
  let chunk: TI[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = line.map((it) => it.text).join(" ");
    const hasTu = /\bTransUnion\b/.test(text);
    const hasEx = /\bExperian\b/.test(text);
    const hasEq = /\bEquifax\b/.test(text);
    const isHeader = hasTu && hasEx && hasEq && line.length >= 3 && line.length <= 8;
    if (isHeader && i > 0) {
      const prev = lines[i - 1]!;
      const prevText = prev.map((it) => it.text).join(" ").trim();
      if (prevText && !/:$/.test(prevText.trim()) && !/^\s*Two-Year/i.test(prevText)) {
        if (chunk.length > 1) accountChunks.push(chunk.slice(0, -1));
        chunk = [prev, line];
        continue;
      }
    }
    chunk.push(line);
  }
  if (chunk.length > 0) accountChunks.push(chunk);

  // Parse each account chunk.
  const accounts: IIQPdfAccount[] = [];
  for (const ch of accountChunks) {
    if (ch.length < 3) continue;
    const credLine = ch[0]!;
    const headerLine = ch[1]!;
    const creditor = credLine.map((it) => it.text).join(" ").replace(/\s+/g, " ").trim();
    if (!creditor || /^Account #/i.test(creditor)) continue;
    const headerText = headerLine.map((it) => it.text).join(" ");
    if (!/TransUnion/i.test(headerText) || !/Experian/i.test(headerText) || !/Equifax/i.test(headerText)) {
      continue;
    }

    const perBureau: Record<IIQPdfBureau, IIQPdfBureauDetail> = {
      transunion: { fields: {}, historyWorstLate: 0, hasData: false },
      experian: { fields: {}, historyWorstLate: 0, hasData: false },
      equifax: { fields: {}, historyWorstLate: 0, hasData: false },
    };

    let inHistory = false;
    for (let li = 2; li < ch.length; li++) {
      const line = ch[li]!;
      const lineText = line.map((it) => it.text).join(" ");

      if (/Two-Year payment history/i.test(lineText)) {
        inHistory = true;
        continue;
      }
      if (inHistory) {
        const bureauItem = line.find((it) => /^(TransUnion|Experian|Equifax)$/i.test(it.text));
        if (!bureauItem) continue;
        const bureau = bureauItem.text.toLowerCase() as IIQPdfBureau;
        let worst = 0;
        for (const it of line) {
          if (it === bureauItem) continue;
          if (!/^\d+$/.test(it.text)) continue;
          const n = parseInt(it.text, 10);
          if (n === 30 || n === 60 || n === 90 || n === 120 || n === 150 || n === 180) {
            if (n > worst) worst = n;
          }
        }
        perBureau[bureau].historyWorstLate = worst;
        continue;
      }

      // Field row: first item ending in ":" is the label; later items are
      // per-bureau values placed at TU/EX/EQ x-positions.
      const labelItem = line.find((it) => /:$/.test(it.text));
      if (!labelItem) continue;
      const labelIdx = line.indexOf(labelItem);
      const label = labelItem.text.replace(/:$/, "").trim();
      if (label.length > 35) continue;
      for (let i = labelIdx + 1; i < line.length; i++) {
        const it = line[i]!;
        const text = it.text.trim();
        if (!text || text === "-") continue;
        const bureau = bureauFromX(it.x);
        if (!perBureau[bureau].fields[label]) {
          perBureau[bureau].fields[label] = text;
        }
      }
    }

    for (const b of BUREAUS) {
      const f = perBureau[b].fields;
      perBureau[b].hasData =
        !!(f["Account #"] || f["Account Number"] || Object.keys(f).length > 0);
    }

    accounts.push({ creditor, perBureau });
  }

  // Extract the Personal Information section (first page or two of the PDF)
  // for prefill in the dashboard. Picks the best non-empty value per field
  // across TU/EX/EQ — usually all three bureaus carry the same name, but
  // Equifax sometimes has a middle initial that TU/EX lack.
  const personalInfo = extractPersonalInfo(lines, cols);

  return { accounts, personalInfo };
}

function extractPersonalInfo(
  lines: TI[][],
  cols: { tu: number; ex: number; eq: number },
): IIQPdfPersonalInfo {
  const bureauFromX = (x: number): IIQPdfBureau => {
    const d = [
      { b: "transunion" as IIQPdfBureau, v: Math.abs(x - cols.tu) },
      { b: "experian" as IIQPdfBureau, v: Math.abs(x - cols.ex) },
      { b: "equifax" as IIQPdfBureau, v: Math.abs(x - cols.eq) },
    ];
    d.sort((a, b) => a.v - b.v);
    return d[0]!.b;
  };

  // Find the Personal Information block. Look for the section heading.
  let piStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.map((it) => it.text).join(" ");
    if (/^Personal Information$/i.test(t.trim())) {
      piStart = i;
      break;
    }
  }
  if (piStart < 0) return { fullName: "", dateOfBirth: "", street: "", cityStateZip: "" };

  // Walk down until we hit a section that's clearly past personal info
  // ("Credit Score" / "Summary" / "Account History"). Collect bureau-keyed
  // values for each label we care about.
  const valuesByBureau: Record<string, Record<IIQPdfBureau, string[]>> = {};
  let currentLabel = "";
  for (let i = piStart + 1; i < lines.length && i < piStart + 60; i++) {
    const line = lines[i]!;
    const t = line.map((it) => it.text).join(" ").trim();
    if (/^(Credit Score|Summary|Account History|Inquiries|Public Records)/i.test(t)) break;
    const labelItem = line.find((it) => /:$/.test(it.text));
    if (labelItem) {
      currentLabel = labelItem.text.replace(/:$/, "").trim();
    }
    if (!currentLabel) continue;
    // Map non-label items to bureaus by x-position
    for (const it of line) {
      if (it === labelItem) continue;
      const text = it.text.trim();
      if (!text || text === "-") continue;
      // Skip bureau-header tokens
      if (/^(TransUnion|Experian|Equifax)$/i.test(text)) continue;
      // Skip the section-block headers/intros
      if (text.length > 80) continue;
      const bureau = bureauFromX(it.x);
      valuesByBureau[currentLabel] = valuesByBureau[currentLabel] ?? {
        transunion: [], experian: [], equifax: [],
      };
      valuesByBureau[currentLabel]![bureau].push(text);
    }
  }

  // Helper: pick the longest non-empty value across bureaus for a label.
  const pickBest = (label: string): string => {
    const v = valuesByBureau[label];
    if (!v) return "";
    const candidates: string[] = [];
    for (const b of BUREAUS) {
      const joined = v[b].join(" ").trim();
      if (joined) candidates.push(joined);
    }
    if (candidates.length === 0) return "";
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0]!;
  };

  // Name + DOB are single-token-per-bureau fields → pickBest works directly.
  const fullName = pickBest("Name");
  // DOB: prefer entries with a "/" (full date) over year-only.
  const dobBureauVals = valuesByBureau["Date of Birth"];
  let dateOfBirth = "";
  if (dobBureauVals) {
    for (const b of BUREAUS) {
      const v = dobBureauVals[b].join(" ").trim();
      if (v && v.includes("/")) { dateOfBirth = v; break; }
    }
    if (!dateOfBirth) dateOfBirth = pickBest("Date of Birth");
  }
  // Current Address: 3+ tokens per bureau (street, city/state, zip, maybe date).
  // Use TU's first 3 lines if present, else EX, else EQ.
  let street = "";
  let cityStateZip = "";
  const addrBureauVals = valuesByBureau["Current Address(es)"];
  if (addrBureauVals) {
    for (const b of BUREAUS) {
      const lines = addrBureauVals[b];
      if (lines.length === 0) continue;
      // First line that doesn't look like a date or zip-only is street
      const streetCandidate = lines.find((s) => !/^\d{2}\/\d{4}$/.test(s) && !/^[A-Z]{2}\s*\d{5}/.test(s) && !/^\d{5}/.test(s));
      const cityStateCandidate = lines.find((s) => /,\s*[A-Z]{2}/.test(s));
      const zipCandidate = lines.find((s) => /^\d{5}(-\d{4})?$/.test(s));
      if (streetCandidate) {
        street = streetCandidate;
        cityStateZip = [cityStateCandidate, zipCandidate].filter(Boolean).join(" ").trim();
        break;
      }
    }
  }
  return { fullName, dateOfBirth, street, cityStateZip };
}

/**
 * Detect the dispute category of an account on a given bureau from its
 * current status fields. Returns null if not negative.
 */
export function classifyIIQNegative(blob: string): string | null {
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

export interface IIQPdfDispute {
  bureau: IIQPdfBureau;
  creditor: string;
  accountNumber: string;
  category: string;
  detail: string;
}

/**
 * Apply the dispute-selection rules:
 *   - Skip deferments (Phillip explicitly doesn't dispute these)
 *   - Flag negative via Account Type / Account Status / Payment Status / Comments
 *   - Flag negative via any payment-history late (30/60/90/120/150/180)
 *   - Cross-bureau propagation: if any bureau is negative, propagate to all
 *     bureaus where the account exists
 */
export function listIIQPdfDisputes(report: IIQPdfReport): IIQPdfDispute[] {
  const out: IIQPdfDispute[] = [];
  for (const a of report.accounts) {
    const allComments = BUREAUS
      .map((b) => (a.perBureau[b].fields["Comments"] ?? "").toLowerCase())
      .join(" ");
    if (/(deferred|in deferment|forbearance)/.test(allComments)) continue;

    const statusByBureau: Record<IIQPdfBureau, string | null> = {
      transunion: null,
      experian: null,
      equifax: null,
    };
    for (const b of BUREAUS) {
      if (!a.perBureau[b].hasData) continue;
      const f = a.perBureau[b].fields;
      const blob = `${f["Account Type"] ?? ""} ${f["Account Status"] ?? ""} ${f["Payment Status"] ?? ""} ${f["Comments"] ?? ""}`;
      statusByBureau[b] = classifyIIQNegative(blob);
    }

    const anyStatusNeg = Object.values(statusByBureau).some((c) => c !== null);
    const anyHistLate = BUREAUS.some((b) => a.perBureau[b].historyWorstLate > 0);
    if (!anyStatusNeg && !anyHistLate) continue;

    let propagated: string | null = null;
    for (const c of Object.values(statusByBureau)) if (c) { propagated = c; break; }
    const worstHistAny = Math.max(...BUREAUS.map((b) => a.perBureau[b].historyWorstLate));

    for (const b of BUREAUS) {
      if (!a.perBureau[b].hasData) continue;
      let category: string;
      if (statusByBureau[b]) category = statusByBureau[b]!;
      else if (a.perBureau[b].historyWorstLate > 0) category = `late${a.perBureau[b].historyWorstLate}`;
      else if (propagated) category = propagated;
      else if (worstHistAny > 0) category = `late${worstHistAny}`;
      else continue;
      const f = a.perBureau[b].fields;
      const accountNumber = f["Account #"] ?? f["Account Number"] ?? "";
      const detail = [
        accountNumber && `#${accountNumber}`,
        f["Date Opened"] && `opened ${f["Date Opened"]}`,
        f["Balance"] && `Balance ${f["Balance"]}`,
      ].filter(Boolean).join(" · ");
      out.push({ bureau: b, creditor: a.creditor, accountNumber, category, detail });
    }
  }
  return out;
}
