/**
 * IIQ HTML extractor — v7 (Account History ng-include walker).
 *
 * Structural breakthrough: IIQ's Account History section contains exactly N
 * `<ng-include src="'tradeLinePartitionBasic'">` blocks — one per account.
 * Each block has its own sub_header (creditor name) and account-detail table
 * with TU/EX/EQ columns. By iterating the ng-include blocks directly we get
 * each account exactly once with no cross-contamination.
 *
 * The previous walker-based approach (v3-v6) over-counted because it grabbed
 * tables from other sections (Inquiries, Creditor Contacts, etc.).
 *
 *   npx tsx apps/dashboard/test/extract-iiq-v7.ts <html-file>
 */

import { readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const BUREAUS = ["transunion", "experian", "equifax"] as const;
type Bureau = (typeof BUREAUS)[number];

interface Account {
  creditor: string;
  perBureau: Record<Bureau, Record<string, string>>;
  isSelfReported: boolean;
  perBureauNegative: Record<Bureau, { negative: boolean; category: string }>;
}

function detectSelfReported(creditor: string, d: Record<string, string>): boolean {
  if (creditor.toUpperCase().includes("SELFREPORT")) return true;
  const acctRaw = d["Account #"] || d["Account Number"] || "";
  if (acctRaw.length > 20 && !acctRaw.includes("*")) return true;
  if (/^[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  if (/^PROD[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  return false;
}

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
  const lateMatch = blob.match(/(\d+)\s*days/);
  if (lateMatch) {
    if (status === "open" || status === "current") return { negative: false, category: "" };
    return { negative: true, category: `late${lateMatch[1]}` };
  }
  if (blob.includes("derogatory")) {
    if (status === "open" || status === "current") return { negative: false, category: "" };
    return { negative: true, category: "derogatory" };
  }
  return { negative: false, category: "" };
}

async function main() {
  const htmlPath = process.argv[2];
  if (!htmlPath) {
    console.error("usage: tsx extract-iiq-v7.ts <html-file>");
    process.exit(1);
  }
  const html = await readFile(htmlPath, "utf8");
  console.log(`\n  HTML: ${(html.length / 1024).toFixed(1)} KB`);

  // Step 1: locate Account History section (between IIQ's HTML comment markers)
  const ahStart = html.indexOf("<!--Account history starts-->");
  const ahEnd = html.indexOf("<!--Account history ends-->");
  if (ahStart < 0) {
    console.error("Could not find Account History section markers");
    process.exit(1);
  }
  const accountHistoryHtml = html.slice(ahStart, ahEnd > 0 ? ahEnd : undefined);
  console.log(`  Account History section: ${(accountHistoryHtml.length / 1024).toFixed(1)} KB`);

  // Step 2: parse the Account History section with cheerio. Each per-account
  // block is wrapped in an ng-include with src='tradeLinePartitionBasic'. We
  // grab each one's HTML chunk by walking the rendered Angular output.
  //
  // The Angular-rendered output for each tradeline looks like:
  //   <ng-include src="'tradeLinePartitionBasic'" ...>
  //     <div class="re-ngInclude tpartition ...">
  //       <div class="sub_header ...">CREDITOR NAME</div>
  //       <table class="...">... all fields with TU/EX/EQ columns ...</table>
  //     </div>
  //   </ng-include>
  //
  // We extract each ng-include's inner HTML, then within it grab the
  // sub_header text + the first table's bureau columns.
  const $ah = cheerio.load(accountHistoryHtml);
  const ngIncludes = $ah('ng-include[src*="tradeLinePartitionBasic"]').toArray();
  console.log(`  Account ng-includes: ${ngIncludes.length}`);

  const accounts: Account[] = [];
  for (const inc of ngIncludes) {
    const $inc = $ah(inc);
    const subHeaderEl = $inc.find("div.sub_header").first();
    if (subHeaderEl.length === 0) continue;
    const creditor = subHeaderEl.text().replace(/ /g, " ").replace(/\s+/g, " ").trim();
    if (!creditor) continue;
    if (creditor.includes("{{")) continue; // unrendered template

    // Find the FIRST table in this ng-include — that's the main account table
    const table = $inc.find("table").first();
    if (table.length === 0) continue;
    const rows = table.find("tr").toArray();
    if (rows.length === 0) continue;

    const firstRowCells = $ah(rows[0]!).find("th, td").toArray().map((c) => $ah(c).text().replace(/\s+/g, " ").trim());
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

    const perBureau: Record<Bureau, Record<string, string>> = { transunion: {}, experian: {}, equifax: {} };
    const startIdx = isHdr ? 1 : 0;
    for (let i = startIdx; i < rows.length; i++) {
      const cells = $ah(rows[i]!).find("th, td").toArray().map((c) => $ah(c).text().replace(/\s+/g, " ").trim());
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

    const isSelf = detectSelfReported(creditor, perBureau.transunion) ||
                   detectSelfReported(creditor, perBureau.experian) ||
                   detectSelfReported(creditor, perBureau.equifax);
    const perBureauNegative: Account["perBureauNegative"] = { transunion: { negative: false, category: "" }, experian: { negative: false, category: "" }, equifax: { negative: false, category: "" } };
    for (const b of BUREAUS) {
      perBureauNegative[b] = flagBureau(perBureau[b], isSelf);
    }

    accounts.push({ creditor, perBureau, isSelfReported: isSelf, perBureauNegative });
  }

  console.log(`  Accounts extracted: ${accounts.length}\n`);

  // Step 3: print per-bureau disputes
  for (const bureau of BUREAUS) {
    const items = accounts.filter((a) => a.perBureauNegative[bureau].negative);
    console.log(`  ${bureau.toUpperCase()} (${items.length}):`);
    for (const a of items) {
      const d = a.perBureau[bureau];
      const detail = [d["Account #"], d["Date Opened"], d["Balance"] && `Balance ${d["Balance"]}`].filter(Boolean).join(" · ");
      console.log(`    ${a.perBureauNegative[bureau].category.padEnd(12)} ${a.creditor.slice(0, 60).padEnd(60)} ${detail}`);
    }
    console.log();
  }

  await writeFile(
    htmlPath.replace(/\.(html|pdf)$/i, "") + "-accounts-v7.json",
    JSON.stringify({ accounts }, null, 2),
    "utf8",
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
