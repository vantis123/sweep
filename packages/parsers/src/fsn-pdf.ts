/**
 * FSN / MFSN downloaded "Three Bureau Credit Report" PDF parser.
 *
 * When a member clicks "Print Selected Document" on MFSN, the page generates
 * a downloadable PDF that pdf-parse extracts as text in this layout:
 *
 *   Three Bureau Credit Report
 *   <Client Name> | <Date>
 *   <Table of contents — sections numbered>
 *
 *   1. Report Summary
 *   ...
 *   Equifax Experian TransUnion
 *   Report Date <date> <date> <date>
 *   Average Account Age <age> <age> <age>
 *   ...
 *   Equifax<rank>
 *   <score>
 *   <rating>
 *   Experian<rank>
 *   <score>
 *   <rating>
 *   ...
 *   Other Credit Items table:
 *     Equifax Experian TransUnion
 *     Collections N N N
 *     Inquiries N N N
 *     ...
 *
 *   2. Revolving Accounts
 *   2.1 <Creditor> (<STATUS>)
 *   ... per-bureau columns Reported / Account Number / Account Status / Credit Limit / Balance ...
 *   ... Days Past Due / Collection / Charge Off rows ...
 *   ... Account Type / Status / Activity Designator / Date Opened ...
 *
 *   3. Mortgage Accounts
 *   4. Installment Accounts
 *   5. Other Accounts
 *   11. Collections
 *
 * STATUS in the heading is one of: OPEN, CLOSED, COLLECTION, BANKRUPTCY,
 * CHARGE-OFF — that alone is a fast negative-detection signal.
 */

import {
  type Account,
  type AccountCategory,
  type Bureau,
  type BureauAccountDetail,
  type BureauSummary,
  type CreditReport,
} from "./types.ts";
import { parseDollar } from "./shared.ts";

const BUREAUS: readonly Bureau[] = ["equifax", "experian", "transunion"] as const;

const NEGATIVE_STATUS_TOKENS = [
  "COLLECTION",
  "CHARGE-OFF",
  "CHARGEOFF",
  "CHARGE OFF",
  "BANKRUPTCY",
  "FORECLOSURE",
  "REPOSSESSION",
  "PAST DUE",
  "DELINQUENT",
];

export function isFSNPdfFormat(text: string): boolean {
  return /Three Bureau Credit Report/i.test(text);
}

export function parseFSNPDF(text: string): CreditReport {
  const report: CreditReport = {
    platform: "fsn",
    reportDate: null,
    referenceNumber: null,
    scores: { equifax: null, experian: null, transunion: null },
    summary: { equifax: {}, experian: {}, transunion: {} },
    accounts: [],
    inquiries: [],
    publicRecords: [],
    personalInfo: {},
    warnings: [],
    errors: [],
  };

  if (!isFSNPdfFormat(text)) {
    report.errors.push("Not a Three Bureau Credit Report PDF");
    return report;
  }

  const lines = text.split(/\r?\n/);

  report.reportDate = extractReportDate(lines);
  extractScores(lines, report);
  extractOtherCreditItems(lines, report);
  extractAccountTypeSummary(lines, report);
  extractAccounts(lines, report);
  extractCollectionsSection(lines, report);

  if (!report.scores.equifax) report.warnings.push("Missing equifax score");
  if (!report.scores.experian) report.warnings.push("Missing experian score");
  if (!report.scores.transunion) report.warnings.push("Missing transunion score");

  return report;
}

// ── Report date ──────────────────────────────────────────────────

function extractReportDate(lines: string[]): string | null {
  for (const raw of lines.slice(0, 30)) {
    const line = raw.trim();
    // "Jeffrey Mendez | May 08, 2026"
    const m = line.match(/\|\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\s*$/);
    if (m && m[1]) return m[1].trim();
  }
  // Fallback — look for "Report Date <Mon DD, YYYY>"
  for (const raw of lines.slice(0, 200)) {
    const line = raw.trim();
    const m = line.match(/Report Date\s+([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

// ── Scores ───────────────────────────────────────────────────────
//
// pdf-parse 2.x squashes "Equifax1\n582\nFair" together. The score is always
// 300-850 and the rating is one of Excellent/Good/Fair/Poor/Very Poor/Bad.

function extractScores(lines: string[], report: CreditReport): void {
  const ratingRe = /^(Excellent|Very Good|Good|Fair|Average|Poor|Very Poor|Bad)\s*$/i;
  for (let i = 0; i < lines.length - 4; i++) {
    const a = (lines[i] ?? "").trim();
    const b = (lines[i + 1] ?? "").trim();
    const c = (lines[i + 2] ?? "").trim();

    // pattern A: bureau+rank concatenated ("Equifax1"), score, rating
    let m = a.match(/^(Equifax|Experian|TransUnion)\s*[1-3]?$/i);
    if (m && /^\d{3}$/.test(b) && ratingRe.test(c)) {
      assignScore(report, m[1]!, parseInt(b, 10));
      continue;
    }
    // pattern B: bureau alone, rank line, score, rating (older layout)
    m = a.match(/^(Equifax|Experian|TransUnion)\s*$/i);
    if (m && /^[1-3]$/.test(b) && /^\d{3}$/.test(c)) {
      const score = parseInt(c, 10);
      assignScore(report, m[1]!, score);
      continue;
    }
  }
}

function assignScore(report: CreditReport, bureau: string, score: number): void {
  if (score < 300 || score > 850) return;
  const key = bureau.toLowerCase() as Bureau;
  if (key === "equifax" || key === "experian" || key === "transunion") {
    report.scores[key] = score;
  }
}

// ── "Other Credit Items" summary table ───────────────────────────
//
// Layout in the print PDF:
//   Equifax Experian TransUnion
//   Consumer Statements N N N
//   Personal Information N N N
//   Inquiries N N N
//   Public Records N N N
//   Collections N N N

function extractOtherCreditItems(lines: string[], report: CreditReport): void {
  for (let i = 0; i < lines.length - 5; i++) {
    if (!/^Equifax\s+Experian\s+TransUnion\s*$/i.test(lines[i] ?? "")) continue;
    // Read up to 8 following rows looking for label+3-numbers
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const row = (lines[j] ?? "").trim();
      const m = row.match(/^([A-Za-z][A-Za-z ]+?)\s+(\d+|N\/A)\s+(\d+|N\/A)\s+(\d+|N\/A)\s*$/);
      if (!m) continue;
      const label = (m[1] ?? "").toLowerCase().trim();
      const eq = parseCount(m[2]);
      const ex = parseCount(m[3]);
      const tu = parseCount(m[4]);
      if (label === "collections" || label === "collection") {
        if (eq !== null) report.summary.equifax.collection = eq;
        if (ex !== null) report.summary.experian.collection = ex;
        if (tu !== null) report.summary.transunion.collection = tu;
      } else if (label === "inquiries") {
        if (eq !== null) report.summary.equifax.inquiries = eq;
        if (ex !== null) report.summary.experian.inquiries = ex;
        if (tu !== null) report.summary.transunion.inquiries = tu;
      } else if (label === "public records") {
        if (eq !== null) report.summary.equifax.publicRecords = eq;
        if (ex !== null) report.summary.experian.publicRecords = ex;
        if (tu !== null) report.summary.transunion.publicRecords = tu;
      }
    }
  }
}

function parseCount(s: string | undefined): number | null {
  if (!s) return null;
  if (/^N\/A$/i.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// ── Account-type summary tables (per bureau totals) ──────────────
//
// Layout:
//   Account Type Open With Balance Total Balance Available Credit Limit Debt-To-Credit Payment
//   Revolving 0 0 $0 $0 $0 0% $0
//   Mortgage 1 1 $46,285 $36,215 $82,500 56% $1,042
//   Installment N/A N/A N/A N/A N/A N/A N/A
//   Other N/A N/A N/A N/A N/A N/A N/A
//   Total 1 1 $46,285 $36,215 $82,500 0% $1,042
//
// One table per bureau. We harvest open/total per type.

function extractAccountTypeSummary(lines: string[], report: CreditReport): void {
  let bureauIdx = 0;
  for (let i = 0; i < lines.length - 6; i++) {
    if (!/Account Type\s+Open\s+With Balance/i.test(lines[i] ?? "")) continue;
    const sum: BureauSummary = report.summary[BUREAUS[bureauIdx] ?? "equifax"] ?? {};
    let totalAccounts = 0;
    let openAccounts = 0;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const row = (lines[j] ?? "").trim();
      // Total row terminates the table
      if (/^Total\s/.test(row)) {
        const tm = row.match(/^Total\s+(\d+|N\/A)\s+(\d+|N\/A)\s/);
        if (tm) {
          const open = parseCount(tm[1]);
          const total = parseCount(tm[2]);
          if (open !== null) sum.openAccounts = open;
          if (total !== null) sum.totalAccounts = total;
        }
        break;
      }
      const tm = row.match(/^(Revolving|Mortgage|Installment|Other)\s+(\d+|N\/A)\s+(\d+|N\/A)\s/);
      if (tm) {
        const open = parseCount(tm[2]);
        const total = parseCount(tm[3]);
        if (open !== null) openAccounts += open;
        if (total !== null) totalAccounts += total;
      }
    }
    if (sum.totalAccounts === undefined && totalAccounts > 0) sum.totalAccounts = totalAccounts;
    if (sum.openAccounts === undefined && openAccounts > 0) sum.openAccounts = openAccounts;
    const bureauKey = BUREAUS[bureauIdx];
    if (bureauKey) report.summary[bureauKey] = sum;
    bureauIdx++;
    if (bureauIdx >= BUREAUS.length) break;
  }
}

// ── Accounts ─────────────────────────────────────────────────────
//
// Each account starts at "<section>.<num> <Creditor> (<STATUS>)" — e.g.
// "2.1 Comenity Bank/expres (CLOSED)". The STATUS in the header is the most
// reliable negative-detection signal:
//   - OPEN, CLOSED → not necessarily negative on its own
//   - COLLECTION, CHARGE-OFF, CHARGEOFF, BANKRUPTCY → negative
//
// Inside each block, the per-bureau detail rows are space-separated:
//   "Account Status Closed Closed N/A"
//   "Credit Limit $500 $500 N/A"
//   "Reported Balance $0 $0 N/A"
//
// We match each account's full block to dig out per-bureau detail.
//
// Section numbers:
//   2 = Revolving · 3 = Mortgage · 4 = Installment · 5 = Other · 11 = Collections
//
// Section 11 entries are inherently negative regardless of status text.

const HEADER_RE = /^(\d+)\.(\d+)\s+(.+?)\s+\(([A-Z][A-Z0-9 \-\/]*?)\)\s*$/;

function extractAccounts(lines: string[], report: CreditReport): void {
  // Find all account headers — keep just the LATEST occurrence of each
  // "<section>.<idx>" since the TOC duplicates them. The detail block lives
  // at the second occurrence (or later, when followed by per-bureau columns).
  type AccountHeader = {
    line: number;
    section: number;
    idx: number;
    creditor: string;
    statusToken: string;
  };
  const headers: AccountHeader[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").trim().match(HEADER_RE);
    if (!m) continue;
    headers.push({
      line: i,
      section: parseInt(m[1]!, 10),
      idx: parseInt(m[2]!, 10),
      creditor: m[3]!.trim(),
      statusToken: m[4]!.trim(),
    });
  }

  // Group by section.idx — keep the LAST one (the detail block, not the TOC).
  const lastByKey = new Map<string, AccountHeader>();
  for (const h of headers) {
    const key = `${h.section}.${h.idx}`;
    lastByKey.set(key, h);
  }

  // Sort by section then idx so output order matches the report
  const detailHeaders = Array.from(lastByKey.values()).sort((a, b) =>
    a.section === b.section ? a.idx - b.idx : a.section - b.section
  );

  for (let h = 0; h < detailHeaders.length; h++) {
    const header = detailHeaders[h]!;
    const next = detailHeaders[h + 1];
    const blockEnd = next?.line ?? lines.length;
    const block = lines.slice(header.line + 1, blockEnd);

    const isCollectionsSection = header.section === 11;
    const isHeaderNegative = NEGATIVE_STATUS_TOKENS.some((t) => header.statusToken.includes(t));

    const detail = parseAccountBlock(block, header);
    const blockNegative = detail.blockNegativeFlag;

    const isNeg = isCollectionsSection || isHeaderNegative || blockNegative;
    const category = pickCategory(header.statusToken, blockNegative, isCollectionsSection);

    report.accounts.push({
      creditor: header.creditor,
      category,
      isNegative: isNeg,
      bureaus: detail.bureaus,
    });
  }
}

interface ParsedAccountBlock {
  bureaus: Partial<Record<Bureau, BureauAccountDetail>>;
  blockNegativeFlag: boolean;
}

function parseAccountBlock(block: string[], header: { creditor: string }): ParsedAccountBlock {
  const bureaus: Partial<Record<Bureau, BureauAccountDetail>> = {
    equifax: {},
    experian: {},
    transunion: {},
  };
  let blockNegativeFlag = false;

  // Walk the block, matching label+3-bureau-values rows.
  for (let i = 0; i < block.length; i++) {
    const row = (block[i] ?? "").trim();
    if (!row) continue;

    // Three-column pattern: "<Label> <eq> <ex> <tu>"
    const m = row.match(/^([A-Za-z][A-Za-z0-9 \-\/]+?)\s{1,}([A-Za-z0-9$,.\-\/]+(?:\s[A-Za-z0-9$,.\-]+)?)\s+([A-Za-z0-9$,.\-\/]+(?:\s[A-Za-z0-9$,.\-]+)?)\s+([A-Za-z0-9$,.\-\/]+(?:\s[A-Za-z0-9$,.\-]+)?)\s*$/);
    if (!m) continue;
    const label = (m[1] ?? "").trim();
    const eq = (m[2] ?? "").trim();
    const ex = (m[3] ?? "").trim();
    const tu = (m[4] ?? "").trim();

    // Negative-status indicator rows — non-zero counts mean negative history
    const lowerLabel = label.toLowerCase();
    if (
      lowerLabel === "collection account" ||
      lowerLabel === "charge off" ||
      lowerLabel === "included in bankruptcy" ||
      /past due/.test(lowerLabel)
    ) {
      if (parseNonZero(eq) || parseNonZero(ex) || parseNonZero(tu)) {
        blockNegativeFlag = true;
      }
      continue;
    }

    // Map labels to BureauAccountDetail fields
    assignField(bureaus.equifax!, label, eq);
    assignField(bureaus.experian!, label, ex);
    assignField(bureaus.transunion!, label, tu);
  }

  // Drop bureaus with no useful data
  for (const b of BUREAUS) {
    const d = bureaus[b];
    if (!d || Object.keys(d).length === 0) delete bureaus[b];
  }

  return { bureaus, blockNegativeFlag };
}

function parseNonZero(s: string): boolean {
  if (!s) return false;
  if (/^N\/A$/i.test(s) || /^0$/.test(s) || s === "$0" || s === "-") return false;
  // numeric or dollar — non-zero means hit
  const n = parseInt(s.replace(/[$,]/g, ""), 10);
  return Number.isFinite(n) && n > 0;
}

function assignField(detail: BureauAccountDetail, label: string, value: string) {
  if (!value || value === "N/A" || value === "-") return;
  const v = value.trim();
  switch (label) {
    case "Account Number":
      detail.accountNumber = v;
      return;
    case "Account Status":
    case "Status":
      detail.accountStatus = v;
      return;
    case "Activity Designator":
      detail.accountCondition = v;
      return;
    case "Account Type":
      detail.accountType = v;
      return;
    case "Loan Type":
      detail.loanType = v;
      return;
    case "Date Opened":
      detail.dateOpened = v;
      return;
    case "Date Closed":
      detail.dateClosed = v;
      return;
    case "Date Reported":
      detail.lastReported = v;
      return;
    case "Credit Limit":
      detail.creditLimit = parseDollar(v);
      return;
    case "Reported Balance":
    case "Balance":
      detail.balance = parseDollar(v);
      return;
    case "High Credit":
    case "High Balance":
      detail.highCredit = parseDollar(v);
      return;
    case "Monthly Payment Amount":
    case "Monthly Payment":
      detail.monthlyPayment = parseDollar(v);
      return;
    case "Amount Past Due":
    case "Past Due":
      detail.pastDue = parseDollar(v);
      return;
    case "Charge Off Amount":
      detail.chargeOffAmount = parseDollar(v);
      return;
  }
}

// ── Collections section (Section 11) ────────────────────────────
//
// Custom layout — not the standard "X.Y Creditor (STATUS)" header. Instead:
//
//   11. Collections
//   <narrative>
//   TransUnion          ← bureau header
//   Date Reported: <date>
//   Agency Client: <CREDITOR>
//   Equifax             ← next bureau header
//   Date Reported: <date>
//   Agency Client: <CREDITOR>
//   ...
//   <per-collection detail blocks>
//
// Each "Agency Client: X" with a preceding "Date Reported: Y" is a separate
// collection. Bureau context resets when we hit a bureau header line.

function extractCollectionsSection(lines: string[], report: CreditReport): void {
  const startIdx = lines.findIndex((l) => /^\s*11\.\s*Collections\s*$/.test((l ?? "").trim()));
  if (startIdx === -1) return;

  // The collections section ends at "12." or end-of-file
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*12\.\s/.test((lines[i] ?? "").trim())) {
      endIdx = i;
      break;
    }
  }

  let currentBureau: Bureau | null = null;
  let pendingDateReported: string | null = null;

  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = (lines[i] ?? "").trim();

    // Bureau header line — exact match, no other content
    if (/^Equifax$/i.test(line)) { currentBureau = "equifax"; continue; }
    if (/^Experian$/i.test(line)) { currentBureau = "experian"; continue; }
    if (/^TransUnion$/i.test(line)) { currentBureau = "transunion"; continue; }

    const dateMatch = line.match(/^Date Reported:\s*(.+)$/);
    if (dateMatch) {
      pendingDateReported = dateMatch[1]?.trim() ?? null;
      continue;
    }

    const agencyMatch = line.match(/^Agency Client:\s*(.+)$/);
    if (agencyMatch && currentBureau) {
      const creditor = (agencyMatch[1] ?? "").trim();
      if (!creditor) continue;
      const detail: BureauAccountDetail = {
        accountStatus: "Collection",
        paymentStatus: "Collection",
        accountType: "COLLECTION",
        lastReported: pendingDateReported ?? undefined,
      };
      report.accounts.push({
        creditor,
        category: "collection",
        isNegative: true,
        bureaus: { [currentBureau]: detail },
      });
      pendingDateReported = null;
    }
  }
}

// ── Category mapping ────────────────────────────────────────────

function pickCategory(
  headerStatus: string,
  blockNegativeFlag: boolean,
  isCollectionsSection: boolean
): AccountCategory {
  const upper = headerStatus.toUpperCase();
  if (isCollectionsSection) return "collection";
  if (upper.includes("CHARGE")) return "chargeoff";
  if (upper.includes("COLLECTION")) return "collection";
  if (upper.includes("BANKRUPTCY")) return "bankruptcy";
  if (upper.includes("FORECLOSURE")) return "foreclosure";
  if (upper.includes("REPOSSESSION")) return "repossession";
  if (upper.includes("PAST DUE") || upper.includes("DELINQUENT")) {
    if (upper.includes("150")) return "late150";
    if (upper.includes("120")) return "late120";
    if (upper.includes("90")) return "late90";
    if (upper.includes("60")) return "late60";
    if (upper.includes("30")) return "late30";
    return "late30";
  }
  if (blockNegativeFlag) return "late30"; // generic late if unknown specifics
  if (upper === "CLOSED") return "closed";
  if (upper === "OPEN") return "current";
  return "unknown";
}
