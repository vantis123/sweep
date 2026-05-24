/**
 * IIQ HTML extractor — v6 (per Phillip's exact rule).
 *
 * Rule: each (sub_header, table) pair in the HTML is its OWN account/listing.
 *       No merging across listings, no canonicalizing names. For each listing,
 *       check each bureau column independently — if it's negative there,
 *       include in that bureau's dispute letter.
 *
 *   npx tsx apps/dashboard/test/extract-iiq-html.ts <html-file>
 */

import { readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const BUREAUS = ["transunion", "experian", "equifax"] as const;
type Bureau = (typeof BUREAUS)[number];

interface Listing {
  creditor: string;
  bureauData: Record<Bureau, Record<string, string>>;
}

interface BureauDispute {
  creditor: string;
  bureau: Bureau;
  category: string;
  detail: string;
}

const NEG_KEYWORDS = ["collection", "charge off", "chargeoff", "charge-off", "derogatory", "foreclosure", "repossession", "bankruptcy"];
const LATE_PATTERNS = [/30\s*days/i, /60\s*days/i, /90\s*days/i, /120\s*days/i, /150\s*days/i, /late\s*30/i, /late\s*60/i, /late\s*90/i, /late\s*120/i];

function isSelfReported(d: Record<string, string>, creditor: string): boolean {
  // Self-reported items (telecom, utility, insurance, education aid) have:
  //   - UUID-style account numbers (long, no asterisk masking, hex pattern)
  //   - Sub_headers containing "SELFREPORTED" or "AIDV"
  // These are IIQ's alternative-credit-data tracking, NOT actual credit accounts.
  const acctRaw = d["Account #"] || d["Account Number"] || "";
  if (creditor.toUpperCase().includes("SELFREPORT")) return true;
  if (acctRaw.length > 20 && !acctRaw.includes("*")) return true; // UUID-ish
  if (/^[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true; // hash + masking
  if (/^PROD[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  return false;
}

function isBureauColumnNegative(d: Record<string, string>, creditor: string = ""): { negative: boolean; category: string } {
  // Substantive data check — empty cells / payment-grid leftovers don't count
  const hasSubstance = Boolean(d["Account #"] || d["Account Number"] || d["Account Status"] || d["Payment Status"]);
  if (!hasSubstance) return { negative: false, category: "" };

  // Per Phillip's highlighted PDF (SPRINGOAKS / 2026-05-23): the fields that
  // signal "this bureau column is negative" are:
  //   - Account Type - Detail (e.g., "Collection", "Chargeoff")
  //   - Account Status (e.g., "Derogatory")
  //   - Payment Status (e.g., "Late 120 Days", "Collection/Chargeoff")
  //   - Comments (e.g., "Collection account", "Charged off as bad debt")
  const status = (d["Account Status"] || "").toLowerCase();
  const pmtStatus = (d["Payment Status"] || "").toLowerCase();
  const comments = (d["Comments"] || "").toLowerCase();
  const typeDetail = (d["Account Type - Detail"] || "").toLowerCase();

  // For SELFREPORTED items (telecom, utility, insurance, etc.): only flag
  // negative if Account Status or Payment Status EXPLICITLY contains a negative
  // keyword. Don't trust Account Type - Detail or Comments for these — they
  // often say generic "Collection" without the underlying account actually
  // being delinquent.
  const selfReported = isSelfReported(d, creditor);
  const blob = selfReported
    ? `${status} ${pmtStatus}` // strict — status/pmt only
    : `${status} ${pmtStatus} ${comments} ${typeDetail}`;

  // Phillip's rule: collections, chargeoffs, foreclosures, repos, bankruptcies
  // are ALWAYS disputed regardless of open/closed status.
  if (blob.includes("charge") && blob.includes("off")) return { negative: true, category: "chargeoff" };
  if (blob.includes("collection")) return { negative: true, category: "collection" };
  if (blob.includes("foreclosure")) return { negative: true, category: "foreclosure" };
  if (blob.includes("repossession")) return { negative: true, category: "repossession" };
  if (blob.includes("bankruptcy")) return { negative: true, category: "bankruptcy" };
  // Late-payment categories: dispute ONLY if the account is CLOSED.
  // "Open account with late payment history" is explicitly skipped per Phillip.
  for (const re of LATE_PATTERNS) {
    if (re.test(blob)) {
      const accountIsOpen = status === "open" || status.includes("open ") || status === "current";
      if (accountIsOpen) return { negative: false, category: "" };
      const m = blob.match(/(\d+)\s*days/);
      const n = m ? m[1] : "30";
      return { negative: true, category: `late${n}` };
    }
  }
  if (blob.includes("derogatory")) {
    const accountIsOpen = status === "open" || status === "current";
    if (accountIsOpen) return { negative: false, category: "" };
    return { negative: true, category: "derogatory" };
  }
  return { negative: false, category: "" };
}

function findPrecedingSubHeader($: cheerio.CheerioAPI, table: cheerio.Element): string {
  let el = $(table) as cheerio.Cheerio<any>;
  for (let depth = 0; depth < 10; depth++) {
    let sib = el.prev();
    while (sib.length > 0) {
      if (sib.hasClass("sub_header")) return sib.text().replace(/\s+/g, " ").trim();
      const inner = sib.find("div.sub_header").last();
      if (inner.length > 0) return inner.text().replace(/\s+/g, " ").trim();
      sib = sib.prev();
    }
    el = el.parent();
    if (el.length === 0) break;
  }
  return "";
}

function parseTable($: cheerio.CheerioAPI, table: cheerio.Element): Record<Bureau, Record<string, string>> | null {
  const rows = $(table).find("tr").toArray();
  if (rows.length === 0) return null;
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
  const data: Record<Bureau, Record<string, string>> = {
    transunion: {}, experian: {}, equifax: {},
  };
  const startIdx = isHdr ? 1 : 0;
  for (let i = startIdx; i < rows.length; i++) {
    const cells = $(rows[i]!).find("th, td").toArray().map((c) => $(c).text().replace(/\s+/g, " ").trim());
    if (cells.length < 2) continue;
    const label = (cells[0] ?? "").replace(/:$/, "");
    if (!label) continue;
    if (/^(transunion|experian|equifax|month|year)$/i.test(label)) continue;
    for (let c = 1; c < cells.length; c++) {
      const bureau = bureauForCol[c];
      if (!bureau) continue;
      const v = cells[c] ?? "";
      if (v && v !== "-") data[bureau][label] = v;
    }
  }
  return data;
}

async function main() {
  const htmlPath = process.argv[2];
  if (!htmlPath) {
    console.error("usage: tsx extract-iiq-html.ts <html-file>");
    process.exit(1);
  }
  const html = await readFile(htmlPath, "utf8");
  console.log(`\n  HTML: ${(html.length / 1024).toFixed(1)} KB`);
  const $ = cheerio.load(html);

  const allText = $("body").text();
  const referenceNumber = allText.match(/Reference\s*#:\s*([A-Z0-9]+)/)?.[1] ?? null;
  const reportDate = allText.match(/Report Date:\s*([0-9/-]+)/)?.[1] ?? null;
  console.log(`  Reference #: ${referenceNumber}`);
  console.log(`  Report Date: ${reportDate}`);

  // Step 1: parse every (sub_header, table) pair as a separate Listing
  const allTables = $("table").toArray();
  const listings: Listing[] = [];
  for (const t of allTables) {
    const hasAcct = $(t).find("tr").toArray().some((r) => /Account\s*#/i.test($(r).text()));
    if (!hasAcct) continue;
    const data = parseTable($, t);
    if (!data) continue;
    const creditor = findPrecedingSubHeader($, t);
    if (!creditor) continue;
    listings.push({ creditor, bureauData: data });
  }
  console.log(`  Total listings parsed: ${listings.length}`);

  // Step 2: for each listing, for each bureau independently, check negative status
  const disputes: BureauDispute[] = [];
  for (const l of listings) {
    for (const bureau of BUREAUS) {
      const d = l.bureauData[bureau];
      const { negative, category } = isBureauColumnNegative(d, l.creditor);
      if (!negative) continue;
      const acctNum = d["Account #"] || d["Account Number"] || "";
      const opened = d["Date Opened"] || "";
      const balance = d["Balance"] || "";
      const detail = [acctNum, opened, balance && `Balance ${balance}`].filter(Boolean).join(" · ");
      disputes.push({ creditor: l.creditor, bureau, category, detail });
    }
  }
  console.log(`  Total per-bureau disputes: ${disputes.length}\n`);

  // Per-bureau breakdown
  for (const bureau of BUREAUS) {
    const items = disputes.filter((d) => d.bureau === bureau);
    console.log(`  ${bureau.toUpperCase()} (${items.length}):`);
    items.forEach((d) => console.log(`    ${d.category.padEnd(12)} ${d.creditor}  [${d.detail}]`));
    console.log();
  }

  await writeFile(
    htmlPath.replace(/\.(html|pdf)$/i, "") + "-listings-v6.json",
    JSON.stringify({ referenceNumber, reportDate, listings, disputes }, null, 2),
    "utf8",
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
