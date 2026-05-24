/**
 * IIQ HTML extractor (v7) — production-grade.
 *
 * Structural walker: IIQ's "Download this report" output has Account History
 * sections bounded by HTML comments (`<!--Account history starts-->` ...
 * `<!--Account history ends-->`). Within that section, each per-account block
 * is wrapped in `<ng-include src="'tradeLinePartitionBasic'">`. There's exactly
 * one ng-include per logical account, each containing one sub_header
 * (creditor name) + one main account-detail table with TU/EX/EQ columns.
 *
 * Walking these ng-includes directly gives one Account per logical entry with
 * no cross-contamination and no over-counting from other report sections
 * (Inquiries, Creditor Contacts, etc.).
 */

import * as cheerio from "cheerio";

export const BUREAUS = ["transunion", "experian", "equifax"] as const;
export type Bureau = (typeof BUREAUS)[number];

export interface IIQAccount {
  /** Creditor name exactly as IIQ shows it (NOT canonicalized across bureaus) */
  creditor: string;
  /** Per-bureau raw field map: "Account #", "Account Status", "Payment Status", etc. */
  perBureau: Record<Bureau, Record<string, string>>;
  /** True if creditor or account number indicates this is a self-reported item
   *  (telecom, utility, insurance, etc.) — these need stricter negative checks. */
  isSelfReported: boolean;
  /** Per-bureau negative-status verdict + category */
  perBureauNegative: Record<Bureau, { negative: boolean; category: string }>;
}

export interface IIQExtraction {
  referenceNumber: string | null;
  reportDate: string | null;
  accounts: IIQAccount[];
}

function detectSelfReported(creditor: string, d: Record<string, string>): boolean {
  if (creditor.toUpperCase().includes("SELFREPORT")) return true;
  const acctRaw = d["Account #"] || d["Account Number"] || "";
  if (acctRaw.length > 20 && !acctRaw.includes("*")) return true;
  if (/^[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  if (/^PROD[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  return false;
}

/**
 * Surface every negative the bureau is reporting. The dispute-selection step
 * decides which to actually dispute (Phillip's team disputes Late/Open items
 * too, even though they're "open" — the parser shouldn't pre-filter them out).
 *
 * Categories: chargeoff | collection | foreclosure | repossession | bankruptcy
 * | late30..late150 | derogatory | "" (not negative).
 *
 * Self-reported items (telecom/utility/insurance/education aid) use a stricter
 * check — Account Status / Payment Status only, ignore Comments and Account
 * Type - Detail — because those fields often contain misleading collection
 * keywords from the original creditor's commentary.
 */
function flagBureau(d: Record<string, string>, selfReported: boolean): { negative: boolean; category: string } {
  const hasSubstance = Boolean(d["Account #"] || d["Account Number"] || d["Account Status"] || d["Payment Status"]);
  if (!hasSubstance) return { negative: false, category: "" };
  const status = (d["Account Status"] || "").toLowerCase();
  const pmt = (d["Payment Status"] || "").toLowerCase();
  const comments = (d["Comments"] || "").toLowerCase();
  const typeDetail = (d["Account Type - Detail"] || "").toLowerCase();
  const blob = selfReported ? `${status} ${pmt}` : `${status} ${pmt} ${comments} ${typeDetail}`;
  if (blob.includes("charge") && blob.includes("off")) return { negative: true, category: "chargeoff" };
  if (blob.includes("collection")) return { negative: true, category: "collection" };
  if (blob.includes("foreclosure")) return { negative: true, category: "foreclosure" };
  if (blob.includes("repossession")) return { negative: true, category: "repossession" };
  if (blob.includes("bankruptcy")) return { negative: true, category: "bankruptcy" };
  // Flag every late account as negative regardless of open/closed — student
  // (or the dispute-selection step) decides which to actually include in
  // letters. The parser's job is to surface every negative.
  const lateMatch = blob.match(/(\d+)\s*days/);
  if (lateMatch) {
    return { negative: true, category: `late${lateMatch[1]}` };
  }
  if (blob.includes("derogatory")) {
    return { negative: true, category: "derogatory" };
  }
  return { negative: false, category: "" };
}

export function extractIIQAccounts(html: string): IIQExtraction {
  // 1. Locate Account History section. IIQ wraps it with HTML comments. If
  //    the markers are missing (rare), fall back to scanning the whole document.
  const ahStart = html.indexOf("<!--Account history starts-->");
  const ahEnd = html.indexOf("<!--Account history ends-->");
  const accountHistoryHtml = ahStart >= 0 ? html.slice(ahStart, ahEnd > 0 ? ahEnd : undefined) : html;

  const $ = cheerio.load(accountHistoryHtml);
  const allText = cheerio.load(html)("body").text();
  const referenceNumber = allText.match(/Reference\s*#:\s*([A-Z0-9]+)/)?.[1] ?? null;
  const reportDate = allText.match(/Report Date:\s*([0-9/-]+)/)?.[1] ?? null;

  // 2. Find each per-account ng-include block. Each one contains exactly one
  //    sub_header + one main account-detail table.
  const ngIncludes = $('ng-include[src*="tradeLinePartitionBasic"]').toArray();
  const accounts: IIQAccount[] = [];

  for (const inc of ngIncludes) {
    const $inc = $(inc);
    const sub = $inc.find("div.sub_header").first();
    if (sub.length === 0) continue;
    const creditor = sub.text().replace(/ /g, " ").replace(/\s+/g, " ").trim();
    if (!creditor || creditor.includes("{{")) continue; // skip unrendered template stub

    const table = $inc.find("table").first();
    if (table.length === 0) continue;
    const rows = table.find("tr").toArray();
    if (rows.length === 0) continue;

    // 3. Detect bureau columns from the first row (header). If no bureau-name
    //    header is found, fall back to the default 3-column layout.
    const firstRowCells = $(rows[0]!).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
    const isHdr = firstRowCells.some((c) => /^(transunion|experian|equifax)$/i.test(c));
    let bureauForCol: (Bureau | "")[] = [];
    if (isHdr) {
      bureauForCol = firstRowCells.map((c) => {
        const l = c.toLowerCase();
        if (l === "transunion") return "transunion";
        if (l === "experian") return "experian";
        if (l === "equifax") return "equifax";
        return "";
      });
    } else {
      bureauForCol = ["", "transunion", "experian", "equifax"];
    }

    // 4. Walk every data row. Skip payment-grid rows (where the first column is
    //    itself a bureau name or Month/Year label).
    const perBureau: Record<Bureau, Record<string, string>> = {
      transunion: {},
      experian: {},
      equifax: {},
    };
    const startIdx = isHdr ? 1 : 0;
    for (let i = startIdx; i < rows.length; i++) {
      const cells = $(rows[i]!).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
      if (cells.length < 2) continue;
      const label = (cells[0] ?? "").replace(/:$/, "").trim();
      if (!label) continue;
      if (/^(transunion|experian|equifax|month|year)$/i.test(label)) continue;
      for (let c = 1; c < cells.length; c++) {
        const bureau = bureauForCol[c];
        if (!bureau) continue;
        const v = cells[c] ?? "";
        if (v && v !== "-") perBureau[bureau][label] = v;
      }
    }

    const isSelf =
      detectSelfReported(creditor, perBureau.transunion) ||
      detectSelfReported(creditor, perBureau.experian) ||
      detectSelfReported(creditor, perBureau.equifax);

    const perBureauNegative: IIQAccount["perBureauNegative"] = {
      transunion: { negative: false, category: "" },
      experian: { negative: false, category: "" },
      equifax: { negative: false, category: "" },
    };
    for (const b of BUREAUS) perBureauNegative[b] = flagBureau(perBureau[b], isSelf);

    accounts.push({ creditor, perBureau, isSelfReported: isSelf, perBureauNegative });
  }

  return { referenceNumber, reportDate, accounts };
}

/**
 * One disputable item per (account, bureau) pair where the bureau column
 * shows negative status. Each item maps cleanly to one row in one bureau's
 * dispute letter.
 */
export interface IIQDispute {
  bureau: Bureau;
  creditor: string;
  category: string;
  accountNumber: string;
  dateOpened: string;
  balance: string;
  detail: string;
}

export function listIIQDisputes(extraction: IIQExtraction): IIQDispute[] {
  const out: IIQDispute[] = [];
  for (const a of extraction.accounts) {
    for (const bureau of BUREAUS) {
      const flag = a.perBureauNegative[bureau];
      if (!flag.negative) continue;
      const d = a.perBureau[bureau];
      const accountNumber = d["Account #"] || d["Account Number"] || "";
      const dateOpened = d["Date Opened"] || "";
      const balance = d["Balance"] || "";
      const detail = [
        accountNumber && `#${accountNumber}`,
        dateOpened && `opened ${dateOpened}`,
        balance && `Balance ${balance}`,
      ].filter(Boolean).join(" · ");
      out.push({ bureau, creditor: a.creditor, category: flag.category, accountNumber, dateOpened, balance, detail });
    }
  }
  return out;
}
