/**
 * Dry-run simulation of what the Claude Code agent would do via the MCP server.
 * Calls the same extract logic, applies Phillip's dispute-selection rules with
 * the kind of reasoning an agent would do (notably: filter self-reported,
 * notice cross-contamination patterns, dedupe within a bureau), then
 * generates the 3 letters.
 */

import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import * as cheerio from "cheerio";

import { BUREAU_CONTACTS, ACCOUNT_DISPUTE_REASONS, renderAffidavitHtml, type AffidavitItem } from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";
import type { Bureau } from "@sweep/parsers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");

const BUREAUS = ["transunion", "experian", "equifax"] as const;

function findPrecedingSubHeader($: cheerio.CheerioAPI, table: any): string {
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

function parseTable($: cheerio.CheerioAPI, table: any) {
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

function detectSelfReported(d: Record<string, string>, creditor: string): boolean {
  const acctRaw = d["Account #"] || d["Account Number"] || "";
  if (creditor.toUpperCase().includes("SELFREPORT")) return true;
  if (acctRaw.length > 20 && !acctRaw.includes("*")) return true;
  if (/^[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  if (/^PROD[A-F0-9]{16,}\*+$/i.test(acctRaw)) return true;
  return false;
}

interface Listing {
  creditor: string;
  perBureau: Record<Bureau, Record<string, string>>;
  isSelfReported: boolean;
}

interface BureauDispute {
  bureau: Bureau;
  creditor: string;
  category: string;
  detail: string;
  reasoning: string; // what an agent would say about why
}

async function main() {
  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  AGENT DRY RUN — simulating Claude Code via MCP server     ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  const htmlPath = "/Users/Krownz/.sweep/stepper/kelly-report.html";
  const clientName = "Kelly Michonda";
  const clientSlug = "kelly-michonda";

  // ── STEP 1: agent calls sweep_extract_accounts ─────────────────────
  console.log(`\n  [Agent] Calling sweep_extract_accounts on ${htmlPath}`);
  const html = await readFile(htmlPath, "utf8");
  const $ = cheerio.load(html);
  const listings: Listing[] = [];
  for (const t of $("table").toArray()) {
    const hasAcct = $(t).find("tr").toArray().some((r) => /Account\s*#/i.test($(r).text()));
    if (!hasAcct) continue;
    const data = parseTable($, t);
    if (!data) continue;
    const creditor = findPrecedingSubHeader($, t);
    if (!creditor) continue;
    const isSelf = detectSelfReported(data.transunion, creditor) || detectSelfReported(data.experian, creditor) || detectSelfReported(data.equifax, creditor);
    listings.push({ creditor, perBureau: data, isSelfReported: isSelf });
  }
  console.log(`  [Tool result] ${listings.length} listings extracted (${listings.filter((l) => l.isSelfReported).length} self-reported)`);

  // ── STEP 2: agent reasoning — apply Phillip's rules ────────────────
  console.log(`\n  [Agent reasoning] Applying Phillip's dispute-selection rules:`);
  console.log(`    1. Each listing independent — no cross-listing merging`);
  console.log(`    2. Per-bureau status independence — only dispute bureau where listing is negative`);
  console.log(`    3. Self-reported items — only if Account/Payment Status explicitly negative`);
  console.log(`    4. Lates — only on closed accounts`);
  console.log(`    5. Skip account-number cross-contamination (data bleeding between adjacent creditors)`);

  const disputes: BureauDispute[] = [];
  const seenPerBureau = new Set<string>(); // dedupe within same bureau by (creditor + acct + opened)

  for (const l of listings) {
    for (const bureau of BUREAUS) {
      const d = l.perBureau[bureau];
      const hasSubstance = Boolean(d["Account #"] || d["Account Number"] || d["Account Status"] || d["Payment Status"]);
      if (!hasSubstance) continue;
      const status = (d["Account Status"] || "").toLowerCase();
      const pmt = (d["Payment Status"] || "").toLowerCase();
      const comments = (d["Comments"] || "").toLowerCase();
      const typeDetail = (d["Account Type - Detail"] || "").toLowerCase();
      const blob = l.isSelfReported ? `${status} ${pmt}` : `${status} ${pmt} ${comments} ${typeDetail}`;

      let category = "";
      let reasoning = "";
      if (blob.includes("charge") && blob.includes("off")) { category = "chargeoff"; reasoning = "Status/Payment indicates charge-off"; }
      else if (blob.includes("collection")) { category = "collection"; reasoning = "Status/Payment indicates collection"; }
      else if (blob.includes("foreclosure")) { category = "foreclosure"; reasoning = "Foreclosure"; }
      else if (blob.includes("repossession")) { category = "repossession"; reasoning = "Repossession"; }
      else if (blob.includes("bankruptcy")) { category = "bankruptcy"; reasoning = "Bankruptcy"; }
      else {
        const lateMatch = blob.match(/(\d+)\s*days/);
        if (lateMatch) {
          if (status === "open" || status === "current") continue; // open lates skipped
          category = `late${lateMatch[1]}`;
          reasoning = `Late ${lateMatch[1]} days on closed account`;
        } else if (blob.includes("derogatory")) {
          if (status === "open" || status === "current") continue;
          category = "derogatory";
          reasoning = "Derogatory on closed";
        } else {
          continue; // not negative
        }
      }

      const acctNum = d["Account #"] || d["Account Number"] || "";
      const opened = d["Date Opened"] || "";
      const balance = d["Balance"] || "";

      // Agent-level dedup: within same bureau, skip if (creditor + acct + opened) already seen
      const dedupKey = `${bureau}|${l.creditor.toUpperCase()}|${acctNum.replace(/[*\s]/g, "")}|${opened.replace(/\//g, "-")}`;
      if (seenPerBureau.has(dedupKey)) continue;
      seenPerBureau.add(dedupKey);

      const detail = [acctNum && `#${acctNum}`, opened && `opened ${opened}`, balance && `Balance ${balance}`].filter(Boolean).join(" · ");
      disputes.push({ bureau, creditor: l.creditor, category, detail, reasoning });
    }
  }

  for (const bureau of BUREAUS) {
    const items = disputes.filter((d) => d.bureau === bureau);
    console.log(`\n  [Agent picks] ${bureau.toUpperCase()} (${items.length} disputes):`);
    items.forEach((d) => console.log(`    • ${d.category.padEnd(11)}  ${d.creditor}  ${d.detail}`));
  }

  // ── STEP 3: agent calls sweep_generate_letters ────────────────────
  console.log(`\n  [Agent] Calling sweep_generate_letters with picked disputes`);
  const outDir = resolve(LETTERS_DIR, clientSlug);
  await mkdir(outDir, { recursive: true });
  const ts = Date.now();
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
    const html = await renderAffidavitHtml({
      client: { fullName: clientName, address: "", cityStateZip: "", dob: "", ssnLast4: "" },
      bureau: BUREAU_CONTACTS[bureau],
      date: dateStr,
      items,
      personalInfoItems: [],
    });
    const fileName = `sweep-agent-${clientSlug}-${bureau}-${ts}.pdf`;
    const outPath = resolve(outDir, fileName);
    await renderLetterPdf({
      html,
      fcra605bPath: FCRA_605B_PATH,
      breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
      outputPath: outPath,
    });
    console.log(`    ✓ ${bureau.padEnd(11)} ${items.length} items  ${(statSync(outPath).size / 1024).toFixed(1)} KB → ${outPath}`);
  }

  console.log(`\n  ✓ Dry run complete. Letters in ${outDir}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
