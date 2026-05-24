/**
 * Bank — shared credit report types
 * These shapes are the contract between the parsers, the funding rules engine,
 * the PDF renderer, the dashboard, and the MCP server.
 */

export type Bureau = "equifax" | "experian" | "transunion";
export const BUREAUS: readonly Bureau[] = ["equifax", "experian", "transunion"] as const;

export type Platform = "fsn" | "iiq" | "smartcredit";

/** Per-bureau score block. */
export interface BureauScores {
  equifax: number | null;
  experian: number | null;
  transunion: number | null;
}

/** Per-bureau summary stats (varies slightly between platforms). */
export interface BureauSummary {
  totalAccounts?: number;
  openAccounts?: number;
  closedAccounts?: number;
  delinquent?: number;
  derogatory?: number;
  collection?: number;
  totalCreditLimit?: number;
  totalAvailableCredit?: number;
  creditUtilization?: number; // percentage 0-100+
  inquiries?: number;
  publicRecords?: number;
  averageAgeMonths?: number; // converted to months for easier math
  positiveAccounts?: number;
  negativeAccounts?: number;
  totalBalance?: number;
}

export type ReportSummary = Record<Bureau, BureauSummary>;

/** Monthly payment status code on the payment-history grid. */
export type PaymentCode =
  | "OK" // current
  | "30" // 30 days late
  | "60"
  | "90"
  | "120"
  | "150"
  | "CO" // charge off
  | "C" // collection
  | "FC" // foreclosure
  | "VS" // voluntary surrender
  | "ND" // no data
  | "--" // not reported
  | string; // fallback for any unknown code

/** One month in the 24-month payment history grid. */
export interface PaymentHistoryEntry {
  month: string; // "Jan 2026" / "2026-01" — preserve source format
  code: PaymentCode;
}

/** Per-bureau detail for an account. */
export interface BureauAccountDetail {
  accountNumber?: string;
  accountType?: string;
  accountTypeDetail?: string;
  accountStatus?: string;
  accountCondition?: string; // OPEN / CLOSED / etc
  ownership?: string; // INDIVIDUAL / JOINT / AUTHORIZED USER
  monthlyPayment?: number | null;
  dateOpened?: string;
  dateClosed?: string;
  balance?: number | null;
  highCredit?: number | null;
  creditLimit?: number | null;
  pastDue?: number | null;
  paymentStatus?: string; // "Current" / "Late 30 Days" / etc
  lastReported?: string;
  lastPayment?: string;
  chargeOffAmount?: number | null;
  monthsReviewed?: number | null;
  comments?: string;
  loanType?: string;
  paymentHistory?: PaymentHistoryEntry[];
  rawFields?: Record<string, string>; // catch-all for fields we don't model yet
}

/** A single account, with per-bureau detail (one account may report differently across bureaus). */
export interface Account {
  /** Best-guess unified creditor name across the 3 bureaus. */
  creditor: string;
  /** Account-level classification (collection, charge-off, current, late, etc) — rolled up across bureaus. */
  category: AccountCategory;
  /** Whether this is negative (any bureau shows negative status). */
  isNegative: boolean;
  bureaus: Partial<Record<Bureau, BureauAccountDetail>>;
}

export type AccountCategory =
  | "current"
  | "late30"
  | "late60"
  | "late90"
  | "late120"
  | "late150"
  | "collection"
  | "chargeoff"
  | "foreclosure"
  | "repossession"
  | "bankruptcy"
  | "settled"
  | "transferred"
  | "closed"
  | "unknown";

/** A credit inquiry. */
export interface Inquiry {
  bureau: Bureau;
  creditor: string;
  date: string;
  type?: "hard" | "soft" | "unknown";
}

/** A public record (bankruptcy, judgment, lien, tax). */
export interface PublicRecord {
  bureau: Bureau;
  type: string;
  date?: string;
  amount?: number | null;
  status?: string;
}

/** Personal information block (per-bureau may differ). */
export interface PersonalInfo {
  name?: Partial<Record<Bureau, string>>;
  birthYear?: Partial<Record<Bureau, string>>;
  ssnLast4?: Partial<Record<Bureau, string>>;
  currentAddress?: Partial<Record<Bureau, string>>;
  previousAddresses?: Partial<Record<Bureau, string[]>>;
  employer?: Partial<Record<Bureau, string>>;
  phone?: Partial<Record<Bureau, string>>;
}

/** The unified credit report shape returned by all parsers. */
export interface CreditReport {
  platform: Platform;
  reportDate: string | null;
  referenceNumber?: string | null;
  scores: BureauScores;
  summary: ReportSummary;
  accounts: Account[];
  inquiries: Inquiry[];
  publicRecords: PublicRecord[];
  personalInfo: PersonalInfo;
  warnings: string[];
  errors: string[];
}

export interface ParseResult<T = CreditReport> {
  ok: boolean;
  data: T;
}
