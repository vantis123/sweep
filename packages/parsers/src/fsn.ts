/**
 * FSN / MyFreeScoreNow / SmartCredit web report parser.
 *
 * Parses the text captured via per-tradeline expand-capture-collapse loop in
 * scripts/extraction/bank-e2e-test.js. The new MFSN layout matches SmartCredit's
 * so this parser handles both.
 *
 * Captured text format:
 *   1. BASELINE section: header, scores, per-bureau summaries, personal info.
 *      Field/value pattern: "Total Accounts\n\n61" — value on next non-empty line.
 *   2. "=== EXPANDED TRADELINES ===" marker
 *   3. Per-tradeline segments delimited by "=== Tradeline N ===":
 *      Each tradeline has fields with TAB-SEPARATED bureau values:
 *        "Account Status\n\tOPEN\tOPEN\tOPEN"
 *        "Charge Off Amount\n\t--\t--\t--"
 *      "--" represents blank/missing value for a bureau.
 *
 * This format is much cleaner than the pdf-parse output (which had
 * "OPENOPENOPEN" concatenated mess). Tab separation gives us reliable
 * per-bureau split with no heuristics needed.
 */

import {
  type Account,
  type AccountCategory,
  type Bureau,
  type BureauAccountDetail,
  type BureauSummary,
  type CreditReport,
  type PaymentHistoryEntry,
} from "./types.ts";
import {
  categorizeBureau,
  isNegativeCategory,
  parseAgeMonths,
  parseDollar,
  rollupCategory,
} from "./shared.ts";

const BUREAU_ORDER: readonly Bureau[] = ["equifax", "experian", "transunion"] as const;

const TRADELINE_DELIM_RE = /=== Tradeline (\d+) ===/g;
const SEE_LESS_RE = /See Less\s*$/;
const EXPANDED_MARKER = "=== EXPANDED TRADELINES ===";

const SECTION_HEADERS: Array<{ pattern: RegExp; section: TradelineSection }> = [
  { pattern: /^Negative Accounts$/i, section: "negative" },
  { pattern: /^Closed Accounts$/i, section: "closed" },
  { pattern: /^Positive Accounts$/i, section: "positive" },
  { pattern: /^Open Accounts$/i, section: "positive" },
  { pattern: /^Mixed Accounts$/i, section: "mixed" },
];

type TradelineSection = "positive" | "negative" | "closed" | "mixed" | "unknown";

function emptyReport(): CreditReport {
  return {
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
}

export function parseFSN(text: string): CreditReport {
  const report = emptyReport();

  const looksLikeFSN =
    /VantageScore/i.test(text) &&
    (/300\s*\n\s*580\s*\n\s*640/.test(text) || /300\s+580\s+640\s+700\s+775\s+850/.test(text));

  if (!looksLikeFSN) {
    report.errors.push("Not a FSN/MFSN/SmartCredit credit report");
    return report;
  }

  // Split into baseline (before EXPANDED marker) and tradeline segments
  const expandedIdx = text.indexOf(EXPANDED_MARKER);
  const baselineText = expandedIdx !== -1 ? text.slice(0, expandedIdx) : text;
  const tradelinesText = expandedIdx !== -1 ? text.slice(expandedIdx + EXPANDED_MARKER.length) : "";

  const baselineLines = baselineText.split("\n").map((l) => l);

  // ── Report date ──
  for (const l of baselineLines) {
    const m = l.trim().match(/^(\d{2}-\d{2}-\d{4})$/);
    if (m) {
      report.reportDate = m[1] ?? null;
      break;
    }
  }

  // ── Scores + per-bureau summary (from baseline) ──
  parseScoresAndSummary(baselineLines, report);

  // ── Tradeline segments (from expanded section, or fall back to baseline) ──
  if (tradelinesText) {
    parseTradelineSegments(tradelinesText, report);
  } else {
    // Fallback for older capture format
    report.warnings.push("No expanded tradelines marker found — running fallback parse");
    parseFallbackTradelines(baselineLines, report);
  }

  return report;
}

/**
 * Find the next non-empty line value after the given index. Skips blank lines.
 * Returns the value and the next index after consuming.
 */
function nextValue(lines: string[], startIdx: number): { value: string; nextIdx: number } | null {
  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed) {
      return { value: trimmed, nextIdx: i + 1 };
    }
  }
  return null;
}

function parseScoresAndSummary(lines: string[], report: CreditReport): void {
  // ── Score gauges: detect "300\n580\n640\n700\n775\n850" sequence ──
  const trimmed = lines.map((l) => (l ?? "").trim());
  const gaugeStarts: number[] = [];
  for (let i = 0; i + 5 < trimmed.length; i++) {
    if (
      trimmed[i] === "300" &&
      trimmed[i + 1] === "580" &&
      trimmed[i + 2] === "640" &&
      trimmed[i + 3] === "700" &&
      trimmed[i + 4] === "775" &&
      trimmed[i + 5] === "850"
    ) {
      gaugeStarts.push(i);
    }
  }

  // After each gauge: the next 3-digit number is the score
  for (let bIdx = 0; bIdx < Math.min(3, gaugeStarts.length); bIdx++) {
    const bureau = BUREAU_ORDER[bIdx]!;
    const start = gaugeStarts[bIdx]! + 6;
    const end = gaugeStarts[bIdx + 1] ?? trimmed.length;
    for (let i = start; i < end; i++) {
      const m = (trimmed[i] ?? "").match(/^(\d{3})$/);
      if (m) {
        const score = parseInt(m[1]!, 10);
        if (score >= 300 && score <= 850) {
          report.scores[bureau] = score;
          break;
        }
      }
    }
  }

  // ── Summary fields: each field appears 3 times across the doc (eq, ex, tu) ──
  // New format: "Total Accounts" alone on a line, value on the NEXT non-empty line
  const counters: Record<string, number> = {};
  function setBureau(field: keyof BureauSummary, value: number): void {
    const idx = counters[field as string] ?? 0;
    if (idx >= 3) return;
    const bureau = BUREAU_ORDER[idx]!;
    (report.summary[bureau] as any)[field] = value;
    counters[field as string] = idx + 1;
  }

  for (let i = 0; i < trimmed.length; i++) {
    const line = trimmed[i] ?? "";

    // Check for known field labels (label-only line)
    if (line === "Total Accounts") {
      const v = nextValue(trimmed, i + 1);
      if (v) {
        const n = parseInt(v.value.replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n)) setBureau("totalAccounts", n);
      }
    } else if (line === "Total Credit Limit") {
      const v = nextValue(trimmed, i + 1);
      if (v) {
        const n = parseDollar(v.value);
        if (n !== null) setBureau("totalCreditLimit", n);
      }
    } else if (line === "Total Available Credit") {
      const v = nextValue(trimmed, i + 1);
      if (v) {
        const n = parseDollar(v.value);
        if (n !== null) setBureau("totalAvailableCredit", n);
      }
    } else if (line === "Credit Utilization") {
      const v = nextValue(trimmed, i + 1);
      if (v) {
        const m = v.value.match(/([\d.]+)\s*%/);
        if (m) setBureau("creditUtilization", parseFloat(m[1]!));
      }
    } else if (line === "Inquiries") {
      const v = nextValue(trimmed, i + 1);
      if (v) {
        const n = parseInt(v.value.replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n)) setBureau("inquiries", n);
      }
    } else if (line === "Public Records") {
      const v = nextValue(trimmed, i + 1);
      if (v) {
        const n = parseInt(v.value.replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n)) setBureau("publicRecords", n);
      }
    } else if (line === "Average Age Accounts") {
      const v = nextValue(trimmed, i + 1);
      if (v) {
        const m = parseAgeMonths(v.value);
        if (m !== null) setBureau("averageAgeMonths", m);
      }
    } else if (line === "Positive Accounts") {
      // "Positive Accounts" header may have a count nearby
      const v = nextValue(trimmed, i + 1);
      if (v && /^\d+$/.test(v.value)) {
        setBureau("positiveAccounts", parseInt(v.value, 10));
      }
    } else if (line === "Negative Accounts") {
      const v = nextValue(trimmed, i + 1);
      if (v && /^\d+$/.test(v.value)) {
        setBureau("negativeAccounts", parseInt(v.value, 10));
      }
    }

    // Inline patterns (older capture format compatibility):
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Total Accounts(\d+)$/))) {
      setBureau("totalAccounts", parseInt(m[1]!, 10));
    } else if ((m = line.match(/^Total Credit Limit\$([\d,.\-]+)$/))) {
      const v = parseDollar(m[1]);
      if (v !== null) setBureau("totalCreditLimit", v);
    } else if ((m = line.match(/^Inquiries(\d+)$/))) {
      setBureau("inquiries", parseInt(m[1]!, 10));
    }
  }
}

/**
 * Parse the "=== Tradeline N ===" delimited segments from the expanded section.
 */
function parseTradelineSegments(text: string, report: CreditReport): void {
  const segments = text.split(TRADELINE_DELIM_RE).filter((s) => s.trim());
  // After split with capture group, we get [intro, segNum, segText, segNum, segText, ...]
  // Pair them up
  const tradelines: Array<{ num: number; text: string }> = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] ?? "";
    if (/^\d+$/.test(s.trim())) {
      tradelines.push({
        num: parseInt(s.trim(), 10),
        text: segments[i + 1] ?? "",
      });
      i++;
    }
  }

  if (tradelines.length === 0) {
    report.warnings.push("No tradeline segments found in expanded section");
    return;
  }

  for (const tl of tradelines) {
    const account = parseTradelineSegment(tl.text);
    if (account) report.accounts.push(account);
  }
}

/**
 * Parse one tradeline segment. Each segment looks like:
 *   <type>See Less
 *   Account Name
 *     <eq>\t<ex>\t<tu>
 *   Account Number
 *     <eq>\t<ex>\t<tu>
 *   Account Status
 *     OPEN\tOPEN\tOPEN
 *   ... etc
 *   Comments
 *     <multi-line bureau-specific text>
 *   Payment History Profile
 *     <month-grid>
 */
function parseTradelineSegment(segText: string): Account | null {
  const lines = segText.split("\n").map((l) => l);
  const fields = extractFieldMapTabs(lines);

  const creditor = pickFirstNonBlank(fields.get("Account Name")) || "Unknown";
  const accountNumberValues = fields.get("Account Number") ?? ["", "", ""];
  const accountTypeValues = fields.get("Account Type") ?? ["", "", ""];
  const accountConditionValues = fields.get("Account Condition") ?? ["", "", ""];
  const ownershipValues = fields.get("Account Ownership Type") ?? ["", "", ""];
  const accountStatusValues = fields.get("Account Status") ?? ["", "", ""];
  const activityDesignatorValues = fields.get("Activity Designator") ?? ["", "", ""];
  const chargeOffValues = fields.get("Charge Off Amount") ?? ["", "", ""];
  const monthlyPaymentValues = fields.get("Monthly Payment") ?? ["", "", ""];
  const balanceValues = fields.get("Balance") ?? ["", "", ""];
  const creditLimitValues = fields.get("Credit Limit") ?? ["", "", ""];
  const highCreditValues = fields.get("High Credit") ?? ["", "", ""];
  const monthsReviewedValues = fields.get("Months Reviewed") ?? ["", "", ""];
  const lastReportedValues = fields.get("Last Reported Date") ?? ["", "", ""];
  const lastActivityValues = fields.get("Last Activity Date") ?? ["", "", ""];
  const accountOpenedValues = fields.get("Account Opened Date") ?? ["", "", ""];
  const loanTypeValues = fields.get("Loan Type Code") ?? ["", "", ""];

  // Comments often have bureau-specific narrative (single block, not tab-separated)
  // Capture as a flat string from the segment text
  const commentsText = extractCommentsBlock(segText);
  const paymentHistoryGrid = parsePaymentHistoryFromSegment(segText);

  const bureaus: Partial<Record<Bureau, BureauAccountDetail>> = {};
  const perBureauCat: Partial<Record<Bureau, AccountCategory>> = {};

  for (let bIdx = 0; bIdx < BUREAU_ORDER.length; bIdx++) {
    const bureau = BUREAU_ORDER[bIdx]!;
    const detail: BureauAccountDetail = {
      accountNumber: accountNumberValues[bIdx] || undefined,
      accountType: accountTypeValues[bIdx] || undefined,
      accountStatus: accountStatusValues[bIdx] || undefined,
      accountCondition: accountConditionValues[bIdx] || undefined,
      ownership: ownershipValues[bIdx] || undefined,
      monthlyPayment: parseDollar(monthlyPaymentValues[bIdx]),
      balance: parseDollar(balanceValues[bIdx]),
      creditLimit: parseDollar(creditLimitValues[bIdx]),
      highCredit: parseDollar(highCreditValues[bIdx]),
      chargeOffAmount: parseDollar(chargeOffValues[bIdx]),
      monthsReviewed: parseInt((monthsReviewedValues[bIdx] || "").replace(/[^\d]/g, ""), 10) || null,
      lastReported: lastReportedValues[bIdx] || undefined,
      lastPayment: lastActivityValues[bIdx] || undefined,
      dateOpened: accountOpenedValues[bIdx] || undefined,
      loanType: loanTypeValues[bIdx] || undefined,
      comments: commentsText || undefined,
      paymentHistory: paymentHistoryGrid,
    };
    bureaus[bureau] = detail;
    perBureauCat[bureau] = categorizeFromAllSignals(detail, segText, activityDesignatorValues[bIdx]);
  }

  const category = rollupCategory(perBureauCat);
  return {
    creditor: creditor.trim(),
    category,
    isNegative: isNegativeCategory(category),
    bureaus,
  };
}

/**
 * Walk segment lines, mapping each "Field Name" line to the next non-empty line's
 * tab-separated bureau values.
 */
function extractFieldMapTabs(lines: string[]): Map<string, [string, string, string]> {
  const fields = new Map<string, [string, string, string]>();
  const FIELD_LABELS = new Set([
    "Account Name",
    "Account Number",
    "Account Type",
    "Account Condition",
    "Account Ownership Type",
    "Phone Number",
    "Term Frequency",
    "Account Opened Date",
    "Account Status",
    "Contact Information",
    "First Reported Date",
    "Last Reported Date",
    "Actual Payment",
    "Monthly Payment",
    "Last Activity Date",
    "Months Reviewed",
    "Creditor Classification",
    "Activity Designator",
    "Charge Off Amount",
    "Deferred Payment Start Date",
    "Deferred Payment StartDate",
    "Balloon Payment Amount",
    "Balloon Payment Date",
    "Loan Type Code",
    "Loan Type Description",
    "Balance",
    "Credit Limit",
    "High Credit",
    "Past Due",
    "Payment Status",
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!FIELD_LABELS.has(line)) continue;

    // Find the next non-empty line — that's the value line
    for (let j = i + 1; j < lines.length; j++) {
      const valLine = lines[j] ?? "";
      const trimmed = valLine.trim();
      if (!trimmed) continue;
      // Skip if the next non-empty line is ALSO a known field label
      if (FIELD_LABELS.has(trimmed)) break;

      // Tab-separated values: "OPEN\tOPEN\tOPEN" → ["OPEN", "OPEN", "OPEN"]
      const parts = valLine.split("\t").map((p) => p.trim()).filter((_, idx) => idx > 0 || valLine.startsWith("\t") === false);
      // Re-split simpler — split by tab, take all non-empty pieces
      const cleanParts = valLine.split(/\t/).map((p) => p.trim()).filter((p) => p.length > 0);

      let triple: [string, string, string];
      if (cleanParts.length === 3) {
        triple = [
          cleanParts[0] === "--" ? "" : cleanParts[0]!,
          cleanParts[1] === "--" ? "" : cleanParts[1]!,
          cleanParts[2] === "--" ? "" : cleanParts[2]!,
        ];
      } else if (cleanParts.length === 1) {
        // Single value (some fields have no per-bureau split)
        const v = cleanParts[0] === "--" ? "" : (cleanParts[0] ?? "");
        triple = [v, v, v];
      } else {
        // Unknown structure — store raw
        const v = trimmed;
        triple = [v, v, v];
      }

      fields.set(line, triple);
      break;
    }
  }

  return fields;
}

function pickFirstNonBlank(triple: [string, string, string] | undefined): string | undefined {
  if (!triple) return undefined;
  for (const v of triple) {
    if (v && v !== "--") return v;
  }
  return undefined;
}

function extractCommentsBlock(segText: string): string {
  const idx = segText.search(/\bComments\b/);
  if (idx === -1) return "";
  // Comments runs until "Payment History Profile" or end of segment
  const remainder = segText.slice(idx);
  const phIdx = remainder.search(/\bPayment History Profile\b/);
  const block = phIdx === -1 ? remainder : remainder.slice(0, phIdx);
  return block.replace(/\bComments\b/, "").trim();
}

function parsePaymentHistoryFromSegment(segText: string): PaymentHistoryEntry[] {
  const idx = segText.search(/\bPayment History Profile\b/);
  if (idx === -1) return [];
  const block = segText.slice(idx);

  const entries: PaymentHistoryEntry[] = [];
  // Pattern: "Jan 2026" on one line, code on next line
  // Also: "Jan 2026\tCO" or "Jan 2026 CO"
  const monthLineRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/g;
  const lines = block.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/);
    if (!m) continue;
    // Code is on next non-empty line OR on same line after the month-year
    let code = "";
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next) continue;
      // Stop if we hit another month-year
      if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/.test(next)) break;
      // Common codes: OK, CO, FC, VS, ND, --, 30, 60, 90, 120, 150, C, D
      if (/^(OK|CO|FC|VS|ND|--|30|60|90|120|150|C|D)$/.test(next)) {
        code = next;
      }
      break;
    }
    entries.push({
      month: `${m[1]} ${m[2]}`,
      code: code || "--",
    });
  }
  return entries;
}

/**
 * Categorize a single bureau's view of the account using ALL available signals.
 */
function categorizeFromAllSignals(
  detail: BureauAccountDetail,
  segText: string,
  activityDesignator: string | undefined
): AccountCategory {
  // Comments scanning — most explicit signal
  if (segText) {
    if (/COLLECTION ACCOUNT/i.test(segText)) return "collection";
    if (/CHARGE.?OFF/i.test(segText) && !/CHARGE OFF AMOUNT[\s\t]+(--|\$0|0\.00)/i.test(segText)) return "chargeoff";
    if (/FORECLOSURE/i.test(segText)) return "foreclosure";
    if (/REPOSSESS/i.test(segText)) return "repossession";
    if (/BANKRUPT/i.test(segText)) return "bankruptcy";

    // Late codes
    if (/=O8|150\s*days/i.test(segText)) return "late150";
    if (/=O7|120\s*days/i.test(segText)) return "late120";
    if (/=O6|90\s*days/i.test(segText)) return "late90";
    if (/=O5|60\s*days/i.test(segText)) return "late60";
    if (/=O4|30\s*days/i.test(segText)) return "late30";

    if (/DELINQUENCY/i.test(segText)) return "late30";
  }

  // Payment History grid signals
  if (detail.paymentHistory && detail.paymentHistory.length > 0) {
    const codes = detail.paymentHistory.map((p) => p.code);
    if (codes.includes("CO") || codes.includes("C")) return "chargeoff";
    if (codes.includes("FC")) return "foreclosure";
    if (codes.includes("VS")) return "repossession";
    if (codes.includes("150")) return "late150";
    if (codes.includes("120")) return "late120";
    if (codes.includes("90")) return "late90";
    if (codes.includes("60")) return "late60";
    if (codes.includes("30")) return "late30";
  }

  // Charge Off Amount > 0
  if ((detail.chargeOffAmount ?? 0) > 0) return "chargeoff";

  // Past Due > 0 (use generic late30 since severity unknown)
  if ((detail.pastDue ?? 0) > 0) return "late30";

  // Activity Designator + Account Status combined
  if (activityDesignator?.toUpperCase() === "CLOSED" || detail.accountCondition?.toUpperCase() === "CLOSED") {
    return "closed";
  }

  if (detail.accountCondition?.toUpperCase() === "OPEN" || detail.accountStatus?.toUpperCase() === "OPEN") {
    return "current";
  }

  return "unknown";
}

/**
 * Fallback: parse tradelines from the older, non-segmented text format
 * (pre-per-tradeline-loop captures). Kept for backward-compat with old fixtures.
 */
function parseFallbackTradelines(lines: string[], report: CreditReport): void {
  // Minimal fallback — just count "See Details" markers and flag warning
  const trimmed = lines.map((l) => (l ?? "").trim());
  const count = trimmed.filter((l) => /See Details\s*$/.test(l)).length;
  if (count > 0) {
    report.warnings.push(
      `Found ${count} unexpanded tradelines (capture flow needs per-tradeline expand to extract negatives)`
    );
  }
}
