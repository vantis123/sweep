/**
 * Legacy MyFreeScoreNow credit report parser
 * (member.myfreescorenow.com — "Powered by ConsumerDirect Platform").
 *
 * The legacy report is single-bureau (Equifax-only) and split into 6 paginated
 * sections: Overview / Personal Info / Consumer Statement / Accounts /
 * Inquiries / Public Records. Section markers look like " 1 of 6 ".
 *
 * Account blocks live in section 4 of 6. Each account is a key-value listing:
 *
 *   Account #:           673928XXXXXX
 *   Account Status:      CLOSED_CHARGE_OFF
 *   Payment Status:      Current
 *   Balance Owed:        $0
 *   Credit Limit:        --
 *   Account Type:        Automobile
 *   Date Opened:         Aug 1, 2019
 *   ...
 *   Account Rating:      Payment after charge off/collection
 *   Account Description: Individual account, Installment account, Automobile
 *   <Creditor name>      ALLY FINANCIAL
 *
 * The creditor name appears AFTER the field block, on its own line, followed
 * by the address and phone.
 *
 * Output: same CreditReport shape as parseFSN / parseIIQ.
 */

import {
  type Account,
  type AccountCategory,
  type BureauAccountDetail,
  type BureauScores,
  type BureauSummary,
  type CreditReport,
  type ReportSummary,
} from "./types.ts";
import { parseDollar } from "./shared.ts";

const BUREAU = "equifax" as const;

export function parseFSNLegacy(text: string): CreditReport {
  const warnings: string[] = [];
  const errors: string[] = [];

  const reportDate = extractReportDate(text);
  const score = extractScore(text);
  const summary = extractSummary(text);
  const accounts = extractAccounts(text, warnings);

  if (score === null) warnings.push("Could not extract credit score");
  if (accounts.length === 0) warnings.push("No accounts extracted");

  const scores: BureauScores = {
    equifax: score,
    experian: null,
    transunion: null,
  };

  const fullSummary: ReportSummary = {
    equifax: summary,
    experian: {},
    transunion: {},
  };

  return {
    platform: "fsn",
    reportDate,
    referenceNumber: null,
    scores,
    summary: fullSummary,
    accounts,
    inquiries: [],
    publicRecords: [],
    personalInfo: {},
    warnings,
    errors,
  };
}

function extractReportDate(text: string): string | null {
  const m = text.match(/Last Updated:\s*([A-Z][a-z]+ \d{1,2},\s*\d{4})/);
  return m && m[1] ? m[1].trim() : null;
}

function extractScore(text: string): number | null {
  const m = text.match(/Credit Score\s*\n+\s*(\d{3})\s*\n/);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    if (n >= 300 && n <= 850) return n;
  }
  const m2 = text.match(/Credit Score:\s*(\d{3})\s+is/);
  if (m2 && m2[1]) {
    const n = parseInt(m2[1], 10);
    if (n >= 300 && n <= 850) return n;
  }
  return null;
}

function extractSummary(text: string): BureauSummary {
  const out: BureauSummary = {};

  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    if (!m || !m[1]) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  };

  const items = num(/Total Items:\s*(\d+)/i);
  if (items !== null) out.totalAccounts = items;
  const open = num(/Open Accounts:\s*(\d+)/i);
  if (open !== null) out.openAccounts = open;
  const closed = num(/Closed Accounts:\s*(\d+)/i);
  if (closed !== null) out.closedAccounts = closed;
  const negs = num(/(\d+)\s*\n+\s*Negative Items/i);
  if (negs !== null) out.negativeAccounts = negs;
  const inq = num(/(\d+)\s*\n+\s*Inquiries/i);
  if (inq !== null) out.inquiries = inq;
  const cols = num(/(\d+)\s*\n+\s*Collections/i);
  if (cols !== null) out.collection = cols;
  const pub = num(/(\d+)\s*\n+\s*Public Records/i);
  if (pub !== null) out.publicRecords = pub;

  const td = text.match(/Total Debts:\s*\$?([\d,]+)/i);
  if (td && td[1]) {
    const v = parseDollar(td[1]);
    if (v !== null) out.totalBalance = v;
  }

  return out;
}

function extractAccounts(text: string, warnings: string[]): Account[] {
  // Each account block starts with "Account #:" and ends before the next one
  // or a section marker. Split on "Account #:" preserving the marker.
  const parts = text.split(/(?=^Account #:)/m);
  const accounts: Account[] = [];

  for (const block of parts) {
    if (!/^Account #:/m.test(block)) continue;
    const acct = parseAccountBlock(block, warnings);
    if (acct) accounts.push(acct);
  }

  return accounts;
}

function parseAccountBlock(block: string, warnings: string[]): Account | null {
  // The legacy format puts each label on its own line, with the value either
  // on the same line ("Label: value") or the next line. Walk lines and match
  // labels.
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fields: Record<string, string> = {};

  // Pull "Label:" lines and the next non-empty line as value
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9 \-#]+?):\s*(.*)$/);
    if (!m || !m[1]) continue;
    const label = m[1].trim();
    let value = (m[2] ?? "").trim();
    if (!value && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next && !/^[A-Za-z][A-Za-z0-9 \-#]+:/.test(next)) {
        value = next;
      }
    }
    fields[label.toLowerCase()] = value;
  }

  // Creditor: the legacy format puts the creditor name after the field block,
  // on a line by itself, followed by an address. Look for an uppercase line
  // that doesn't match a label pattern, before "Phone:" or "Action History:".
  const creditor = extractCreditor(lines);

  const accountType = fields["account type"] ?? "";
  const accountStatus = fields["account status"] ?? "";
  const accountRating = fields["account rating"] ?? "";
  const paymentStatus = fields["payment status"] ?? "";
  const accountDescription = fields["account description"] ?? "";

  const detail: BureauAccountDetail = {
    accountNumber: fields["account #"],
    accountType: normalizeType(accountType, accountDescription),
    accountTypeDetail: accountDescription || undefined,
    accountStatus,
    paymentStatus,
    balance: parseDollar(fields["balance owed"] ?? null),
    monthlyPayment: parseDollar(fields["payment amount"] ?? null),
    creditLimit: parseDollar(fields["credit limit"] ?? null),
    highCredit: parseDollar(fields["high balance"] ?? null),
    dateOpened: fields["date opened"],
    lastReported: fields["account verified"],
    lastPayment: fields["last payment"],
    comments: fields["creditor remarks"] || accountRating || undefined,
    rawFields: fields,
  };

  const category = categorize(accountStatus, accountRating, paymentStatus);
  const isNeg = isNegativeStatus(accountStatus, accountRating, category);

  return {
    creditor: creditor || "Unknown Creditor",
    category,
    isNegative: isNeg,
    bureaus: { [BUREAU]: detail },
  };
}

function extractCreditor(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("Phone:") || line.startsWith("Action History:") || line.startsWith("No Actions")) continue;
    if (/,\s*\w{2}\s*\d{5}/.test(line)) continue;
    if (/^P\.?O\.?\s*BOX/i.test(line) || /^\d+\s+\w/.test(line)) continue;
    if (/^[A-Za-z][A-Za-z0-9 \-]+:/.test(line)) continue;
    if (/^\d+ of \d+$/.test(line) || line.length < 3) continue;
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (letters.length > 2 && letters === letters.toUpperCase()) {
      return line;
    }
  }
  return null;
}

function normalizeType(accountType: string, description: string): string {
  const blob = `${accountType} ${description}`.toUpperCase();
  if (blob.includes("REVOLVING") || blob.includes("CREDIT CARD")) return "REVOLVING";
  if (blob.includes("INSTALLMENT") || blob.includes("AUTOMOBILE") || blob.includes("AUTO")) return "INSTALLMENT";
  if (blob.includes("MORTGAGE")) return "MORTGAGE";
  if (blob.includes("LINE OF CREDIT") || blob.includes("HELOC")) return "LINE_OF_CREDIT";
  return accountType.toUpperCase();
}

function categorize(
  accountStatus: string,
  accountRating: string,
  paymentStatus: string
): AccountCategory {
  const s = (accountStatus || "").toUpperCase();
  const r = (accountRating || "").toLowerCase();
  const p = (paymentStatus || "").toLowerCase();

  if (s.includes("CHARGE_OFF") || s.includes("CHARGE-OFF") || s === "CO") return "chargeoff";
  if (s.includes("COLLECTION") || r.includes("collection")) return "collection";
  if (s.includes("FORECLOSURE") || r.includes("foreclos")) return "foreclosure";
  if (s.includes("REPOSSESSION") || r.includes("repo")) return "repossession";
  if (s.includes("BANKRUPTCY") || r.includes("bankrupt")) return "bankruptcy";

  if (r.includes("payment after charge off") || r.includes("after charge off")) return "chargeoff";

  if (r.includes("150 day")) return "late150";
  if (r.includes("120 day")) return "late120";
  if (r.includes("90 day")) return "late90";
  if (r.includes("60 day")) return "late60";
  if (r.includes("30 day")) return "late30";

  if (s === "CLOSED" || s.includes("CLOSED")) return "closed";
  if (s === "OPEN" || p.includes("current")) return "current";

  return "unknown";
}

function isNegativeStatus(
  accountStatus: string,
  accountRating: string,
  category: AccountCategory
): boolean {
  const NEG_CATS = new Set([
    "collection",
    "chargeoff",
    "foreclosure",
    "repossession",
    "bankruptcy",
    "late30",
    "late60",
    "late90",
    "late120",
    "late150",
  ]);
  if (NEG_CATS.has(category)) return true;
  // Account Rating signals like "60 days past due" on a closed account
  const r = (accountRating || "").toLowerCase();
  if (r.includes("past due") || r.includes("late")) return true;
  return false;
}

/** Heuristic: does this text look like the legacy ConsumerDirect format? */
export function looksLikeFSNLegacy(text: string): boolean {
  return (
    /ConsumerDirect Platform/i.test(text) ||
    /Powered\s+By\s+ConsumerDirect/i.test(text) ||
    (/CREDIT REPORT OVERVIEW AS OF/i.test(text) && /\d+ of 6\b/.test(text))
  );
}
