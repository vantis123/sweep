/**
 * IdentityIQ credit report text parser.
 * Ported from arvantis-tech/apps/workers/src/services/extractors/gdrive-ocr.js
 * (parseIIQCreditReportText), retypped for the Bank CreditReport contract.
 *
 * Input: text extracted via pdf-parse from a captured IIQ credit report PDF.
 * Output: typed CreditReport.
 */

import {
  type Account,
  type AccountCategory,
  type Bureau,
  type BureauAccountDetail,
  type BureauScores,
  type BureauSummary,
  type CreditReport,
  type Inquiry,
  type PersonalInfo,
  type PublicRecord,
  type ReportSummary,
} from "./types.ts";
import {
  categorizeBureau,
  isNegativeCategory,
  parseDollar,
  rollupCategory,
  split3Equal,
  splitDollars3,
  splitEqualOrNull,
} from "./shared.ts";

const BUREAU_ORDER: readonly Bureau[] = ["transunion", "experian", "equifax"] as const;

interface RawBureauFields {
  accountNumber?: string;
  accountType?: string;
  accountTypeDetail?: string;
  bureauCode?: string;
  accountStatus?: string;
  monthlyPayment?: number | null;
  dateOpened?: string;
  balance?: number | null;
  highCredit?: number | null;
  creditLimit?: number | null;
  pastDue?: number | null;
  paymentStatus?: string;
  lastReported?: string;
  lastActive?: string;
  dateLastPayment?: string;
}

const ACCT_FIELDS: Array<{
  re: RegExp;
  key: keyof RawBureauFields;
  isDollar?: boolean;
}> = [
  { re: /^Account #:(.+)$/i, key: "accountNumber" },
  { re: /^Account Type:(.+)$/i, key: "accountType" },
  { re: /^Account Type - Detail:(.+)$/i, key: "accountTypeDetail" },
  { re: /^Bureau Code:(.+)$/i, key: "bureauCode" },
  { re: /^Account Status:(.+)$/i, key: "accountStatus" },
  { re: /^Monthly Payment:(.+)$/i, key: "monthlyPayment", isDollar: true },
  { re: /^Date Opened:(.+)$/i, key: "dateOpened" },
  { re: /^Balance:(.+)$/i, key: "balance", isDollar: true },
  { re: /^High Credit:(.+)$/i, key: "highCredit", isDollar: true },
  { re: /^Credit Limit:(.+)$/i, key: "creditLimit", isDollar: true },
  { re: /^Past Due:(.+)$/i, key: "pastDue", isDollar: true },
  { re: /^Payment Status:(.+)$/i, key: "paymentStatus" },
  { re: /^Last Reported:(.+)$/i, key: "lastReported" },
  { re: /^Last Active:(.+)$/i, key: "lastActive" },
  { re: /^Date Last Payment:(.+)$/i, key: "dateLastPayment" },
];

const SUMMARY_FIELDS: Array<{
  re: RegExp;
  key: keyof BureauSummary;
  isDollar?: boolean;
}> = [
  { re: /^Total Accounts:(\d+)$/i, key: "totalAccounts" },
  { re: /^Open Accounts:(\d+)$/i, key: "openAccounts" },
  { re: /^Closed Accounts:(\d+)$/i, key: "closedAccounts" },
  { re: /^Delinquent:(\d+)$/i, key: "delinquent" },
  { re: /^Derogatory:(\d+)$/i, key: "derogatory" },
  { re: /^Collection:(\d+)$/i, key: "collection" },
  { re: /^Balances:(.+)$/i, key: "totalBalance", isDollar: true },
  { re: /^Public Records:(\d+)$/i, key: "publicRecords" },
  { re: /^Inquiries\(2 years\):(\d+)$/i, key: "inquiries" },
];

const STOP_HEADERS = /^(Inquiries|Public Records|Two-Year|Account History|Personal Information|Credit Score)\b/i;
const TBC_HDR = /^TransUnionExperianEquifax$/i;

function emptyReport(): CreditReport {
  return {
    platform: "iiq",
    reportDate: null,
    referenceNumber: null,
    scores: { equifax: null, experian: null, transunion: null },
    summary: {
      equifax: {},
      experian: {},
      transunion: {},
    },
    accounts: [],
    inquiries: [],
    publicRecords: [],
    personalInfo: {},
    warnings: [],
    errors: [],
  };
}

export function parseIIQ(text: string): CreditReport {
  const report = emptyReport();

  // Detection accepts either pdf-parse's concatenated bureau headers
  // ("TransUnionExperianEquifax") or innerText's whitespace-separated ones
  // ("TransUnion\tExperian\tEquifax"). Different ingest paths produce
  // different layouts; both are real IIQ reports.
  const looksLikeIIQ =
    /Three Bureau Credit Report/i.test(text) &&
    /Reference #:/i.test(text) &&
    /TransUnion\s*Experian\s*Equifax/i.test(text);

  if (!looksLikeIIQ) {
    report.errors.push("Not an IdentityIQ credit report");
    return report;
  }

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // ── Reference # + report date ──
  const refIdx = lines.findIndex((l) => /^Reference\s*#:/i.test(l));
  if (refIdx !== -1 && lines[refIdx + 1]) report.referenceNumber = lines[refIdx + 1] ?? null;

  const rdIdx = lines.findIndex((l) => /^Report Date:/i.test(l));
  if (rdIdx !== -1 && lines[rdIdx + 1]) report.reportDate = lines[rdIdx + 1] ?? null;

  // ── Scores ──
  // "Credit Score:517464472" → 3 bureaus reported
  // "Credit Score:574--" → only TU has data, EX/EQ are "-" placeholders
  for (const l of lines) {
    const m = l.match(/^Credit Score:(\d{3}|-)(\d{3}|-)(\d{3}|-)$/);
    if (m) {
      const [, tuStr, exStr, eqStr] = m;
      report.scores.transunion = tuStr === "-" ? null : parseInt(tuStr!, 10);
      report.scores.experian = exStr === "-" ? null : parseInt(exStr!, 10);
      report.scores.equifax = eqStr === "-" ? null : parseInt(eqStr!, 10);
      break;
    }
  }

  // ── Summary ──
  parseSummary(lines, report);

  // ── Accounts ──
  parseAccounts(lines, report);

  return report;
}

function parseSummary(lines: string[], report: CreditReport): void {
  const summaryIdx = lines.findIndex((l) => /^Summary\b/i.test(l));
  if (summaryIdx === -1) {
    report.warnings.push("Summary section not found");
    return;
  }

  const end = Math.min(summaryIdx + 30, lines.length);
  for (let i = summaryIdx; i < end; i++) {
    const line = lines[i];
    if (!line) continue;

    for (const field of SUMMARY_FIELDS) {
      const m = line.match(field.re);
      if (!m) continue;
      const valStr = m[1];
      if (!valStr) break;

      if (field.isDollar) {
        const [tu, ex, eq] = splitDollars3(valStr);
        setSummaryValue(report.summary.transunion, field.key, tu);
        setSummaryValue(report.summary.experian, field.key, ex);
        setSummaryValue(report.summary.equifax, field.key, eq);
      } else {
        const split = splitEqualOrNull(valStr);
        if (split) {
          const [tu, ex, eq] = split;
          setSummaryValue(report.summary.transunion, field.key, parseInt(tu, 10));
          setSummaryValue(report.summary.experian, field.key, parseInt(ex, 10));
          setSummaryValue(report.summary.equifax, field.key, parseInt(eq, 10));
        } else {
          // ambiguous (e.g., "11119" = 11/11/9) — store raw, log warning
          report.warnings.push(`Summary ${String(field.key)}: ambiguous split for "${valStr}"`);
        }
      }
      break;
    }
  }
}

function setSummaryValue<K extends keyof BureauSummary>(
  s: BureauSummary,
  key: K,
  value: number | null
): void {
  if (value === null || Number.isNaN(value)) return;
  (s as any)[key] = value;
}

function isCreditorLine(line: string, nextLine: string | undefined): boolean {
  return (
    /^[A-Z][A-Z0-9\s\/&.'\-]{1,}$/.test(line) && TBC_HDR.test(nextLine ?? "")
  );
}

function parseAccounts(lines: string[], report: CreditReport): void {
  const acctStartIdx = lines.findIndex((l) => /^Account History/i.test(l));
  if (acctStartIdx === -1) return;

  let i = acctStartIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }
    if (/^(Inquiries|Public Records)\b/i.test(line)) break;

    if (isCreditorLine(line, lines[i + 1])) {
      const rawByBureau: Record<Bureau, RawBureauFields> = {
        transunion: {},
        experian: {},
        equifax: {},
      };

      let j = i + 2;
      while (j < lines.length) {
        const fl = lines[j];
        if (!fl) {
          j++;
          continue;
        }
        if (TBC_HDR.test(fl)) break;
        if (STOP_HEADERS.test(fl)) break;
        if (isCreditorLine(fl, lines[j + 1])) break;

        for (const field of ACCT_FIELDS) {
          const m = fl.match(field.re);
          if (!m) continue;
          const valStr = m[1];
          if (!valStr) break;

          if (field.isDollar) {
            const [tu, ex, eq] = splitDollars3(valStr);
            (rawByBureau.transunion as any)[field.key] = tu;
            (rawByBureau.experian as any)[field.key] = ex;
            (rawByBureau.equifax as any)[field.key] = eq;
          } else {
            const split = splitEqualOrNull(valStr);
            if (split) {
              (rawByBureau.transunion as any)[field.key] = split[0];
              (rawByBureau.experian as any)[field.key] = split[1];
              (rawByBureau.equifax as any)[field.key] = split[2];
            } else {
              // No clean split — assign full string to all 3 (downstream interprets)
              (rawByBureau.transunion as any)[field.key] = valStr;
              (rawByBureau.experian as any)[field.key] = valStr;
              (rawByBureau.equifax as any)[field.key] = valStr;
            }
          }
          break;
        }
        j++;
      }

      // Build Account from raw fields
      const account = buildAccount(line, rawByBureau);
      report.accounts.push(account);
      i = j;
    } else {
      i++;
    }
  }
}

function buildAccount(creditor: string, raw: Record<Bureau, RawBureauFields>): Account {
  const bureaus: Partial<Record<Bureau, BureauAccountDetail>> = {};
  const perBureauCat: Partial<Record<Bureau, AccountCategory>> = {};

  for (const b of BUREAU_ORDER) {
    const r = raw[b];
    const detail: BureauAccountDetail = {
      accountNumber: r.accountNumber,
      accountType: r.accountType,
      accountTypeDetail: r.accountTypeDetail,
      ownership: r.bureauCode,
      accountStatus: r.accountStatus,
      monthlyPayment: r.monthlyPayment ?? null,
      dateOpened: r.dateOpened,
      balance: r.balance ?? null,
      highCredit: r.highCredit ?? null,
      creditLimit: r.creditLimit ?? null,
      pastDue: r.pastDue ?? null,
      paymentStatus: r.paymentStatus,
      lastReported: r.lastReported,
      lastPayment: r.dateLastPayment,
    };
    bureaus[b] = detail;
    perBureauCat[b] = categorizeBureau(detail);
  }

  const category = rollupCategory(perBureauCat);
  return {
    creditor: creditor.trim(),
    category,
    isNegative: isNegativeCategory(category),
    bureaus,
  };
}
