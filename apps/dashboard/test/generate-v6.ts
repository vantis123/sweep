/**
 * v6 letter generator — feeds the v6 per-listing-per-bureau disputes directly
 * to the letter renderer. No merging, no canonicalizing. Each listing that
 * shows negative on a bureau gets included in that bureau's letter.
 *
 *   npx tsx apps/dashboard/test/generate-v6.ts <html-file> <client-name>
 */

import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import * as cheerio from "cheerio";

import { BUREAU_CONTACTS, ACCOUNT_DISPUTE_REASONS, renderAffidavitHtml, type AffidavitItem, type AffidavitInput } from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";
import type { Bureau } from "@sweep/parsers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");

const BUREAUS = ["transunion", "experian", "equifax"] as const;
const LATE_PATTERNS = [/30\s*days/i, /60\s*days/i, /90\s*days/i, /120\s*days/i, /150\s*days/i, /late\s*30/i, /late\s*60/i, /late\s*90/i, /late\s*120/i];

function isSelfReported(d: Record<string, string>, creditor: string): boolean {
  const acctRaw = d["Account #"] || d["Account Number"] || "";
  if (creditor.toUpperCase().includes("SELFREPORT")) return true;
  if (acctRaw.length > 20 && !acctRaw.includes("*")) return true;
  if (/^[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  if (/^PROD[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  return false;
}

function isBureauColumnNegative(d: Record<string, string>, creditor: string = ""): { negative: boolean; category: string } {
  const hasSubstance = Boolean(d["Account #"] || d["Account Number"] || d["Account Status"] || d["Payment Status"]);
  if (!hasSubstance) return { negative: false, category: "" };
  const status = (d["Account Status"] || "").toLowerCase();
  const selfReported = isSelfReported(d, creditor);
  // Self-reported items: strict check — status/pmt only, ignore comments + type detail
  const blob = selfReported
    ? `${status} ${(d["Payment Status"] || "").toLowerCase()}`
    : `${status} ${(d["Payment Status"] || "").toLowerCase()} ${(d["Comments"] || "").toLowerCase()} ${(d["Account Type - Detail"] || "").toLowerCase()}`;
  // Collections, chargeoffs, foreclosures, repos, bankruptcies: always dispute
  if (blob.includes("charge") && blob.includes("off")) return { negative: true, category: "chargeoff" };
  if (blob.includes("collection")) return { negative: true, category: "collection" };
  if (blob.includes("foreclosure")) return { negative: true, category: "foreclosure" };
  if (blob.includes("repossession")) return { negative: true, category: "repossession" };
  if (blob.includes("bankruptcy")) return { negative: true, category: "bankruptcy" };
  // Late history: ONLY dispute on CLOSED accounts (Phillip's rule: open lates skipped)
  for (const re of LATE_PATTERNS) {
    if (re.test(blob)) {
      if (status === "open" || status === "current") return { negative: false, category: "" };
      const m = blob.match(/(\d+)\s*days/);
      const n = m ? m[1] : "30";
      return { negative: true, category: `late${n}` };
    }
  }
  if (blob.includes("derogatory")) {
    if (status === "open" || status === "current") return { negative: false, category: "" };
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

function parseTable($: cheerio.CheerioAPI, table: cheerio.Element) {
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
  const data: Record<Bureau, Record<string, string>> = { transunion: {}, experian: {}, equifax: {} };
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

interface DisputeItem {
  creditor: string;
  bureau: Bureau;
  category: string;
  detail: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
}

async function main() {
  const htmlPath = process.argv[2];
  const clientNameArg = process.argv[3] ?? "Test Client";
  if (!htmlPath) {
    console.error("usage: tsx generate-v6.ts <html-file> <client-name>");
    process.exit(1);
  }
  const html = await readFile(htmlPath, "utf8");
  const $ = cheerio.load(html);

  // Extract disputes (one per listing per bureau where negative)
  const disputes: DisputeItem[] = [];
  for (const t of $("table").toArray()) {
    const hasAcct = $(t).find("tr").toArray().some((r) => /Account\s*#/i.test($(r).text()));
    if (!hasAcct) continue;
    const data = parseTable($, t);
    if (!data) continue;
    const creditor = findPrecedingSubHeader($, t);
    if (!creditor) continue;
    for (const bureau of BUREAUS) {
      const d = data[bureau];
      const { negative, category } = isBureauColumnNegative(d, creditor);
      if (!negative) continue;
      const acctNum = d["Account #"] || d["Account Number"] || "";
      const opened = d["Date Opened"] || "";
      const balance = d["Balance"] || "";
      const detail = [acctNum && `#${acctNum}`, opened && `opened ${opened}`, balance && `Balance ${balance}`].filter(Boolean).join(" · ");
      disputes.push({ creditor, bureau, category, detail });
    }
  }

  console.log(`\n  Disputes: TU=${disputes.filter((d) => d.bureau === "transunion").length}  EX=${disputes.filter((d) => d.bureau === "experian").length}  EQ=${disputes.filter((d) => d.bureau === "equifax").length}`);

  // Build letters per bureau using v6 disputes directly
  const clientSlug = slugify(clientNameArg);
  const outDir = resolve(LETTERS_DIR, clientSlug);
  await mkdir(outDir, { recursive: true });
  const timestamp = Date.now();
  const dateStr = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  for (const bureau of BUREAUS) {
    const items: AffidavitItem[] = disputes
      .filter((d) => d.bureau === bureau)
      .map((d) => ({
        creditor: d.creditor,
        detail: d.detail,
        reasonText: ACCOUNT_DISPUTE_REASONS.find((r) => r.id === "not-mine")!.text,
      }));
    if (items.length === 0) continue;
    const input: AffidavitInput = {
      client: { fullName: clientNameArg, address: "", cityStateZip: "", dob: "", ssnLast4: "" },
      bureau: BUREAU_CONTACTS[bureau],
      date: dateStr,
      items,
      personalInfoItems: [],
    };
    const html = await renderAffidavitHtml(input);
    const fileName = `sweep-v6-${clientSlug}-${bureau}-${timestamp}.pdf`;
    const outPath = resolve(outDir, fileName);
    await renderLetterPdf({
      html,
      fcra605bPath: FCRA_605B_PATH,
      breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
      outputPath: outPath,
    });
    const size = statSync(outPath).size;
    console.log(`    ✓ ${bureau.padEnd(11)} ${items.length} items  ${(size / 1024).toFixed(1)} KB → ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
