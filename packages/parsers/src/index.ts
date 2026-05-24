/**
 * @sweep/parsers — credit report text parsers.
 *
 * Two parsers covering all v1 platforms:
 *   - parseIIQ: IdentityIQ credit reports (PDF text via pdf-parse)
 *   - parseFSN: MyFreeScoreNow web-rendered reports (also handles SmartCredit
 *     since the new MFSN layout matches SC's)
 *
 * Both return the same typed CreditReport shape.
 */

import type { CreditReport } from "./types.ts";
import { parseFSN } from "./fsn.ts";
import { parseFSNLegacy, looksLikeFSNLegacy } from "./fsn-legacy.ts";
import { parseFSNPDF, isFSNPdfFormat } from "./fsn-pdf.ts";
import { parseFSN3B, looksLikeFSN3B } from "./fsn-3b.ts";

export { parseIIQ } from "./iiq.ts";
export { parseFSN } from "./fsn.ts";
export { parseFSNLegacy, looksLikeFSNLegacy } from "./fsn-legacy.ts";
export { parseFSNPDF, isFSNPdfFormat } from "./fsn-pdf.ts";
export { parseFSN3B, looksLikeFSN3B } from "./fsn-3b.ts";

// v7 IIQ HTML extractor — production parser for IIQ "Download this report" HTML
export { extractIIQAccounts, listIIQDisputes } from "./iiq-html.ts";
export type { IIQAccount, IIQDispute, IIQExtraction, Bureau as IIQBureau } from "./iiq-html.ts";

// IIQ PDF parser — positional text extraction via pdfjs-dist. Use this when
// the IIQ flow captured the rendered report as a PDF (via page.pdf() after
// clicking "Print this page"). Handles single-bureau collection accounts
// where pdf-parse loses column attribution.
export { parseIIQPdf, listIIQPdfDisputes, classifyIIQNegative } from "./iiq-pdf.ts";
export type {
  IIQPdfReport,
  IIQPdfAccount,
  IIQPdfBureauDetail,
  IIQPdfDispute,
  IIQPdfBureau,
} from "./iiq-pdf.ts";

// shared negative-category helpers (used by validation tooling)
export { isNegativeCategory, categorizeBureau } from "./shared.ts";

/**
 * Auto-pick FSN parser variant. Bank handles three FSN formats:
 *   - Print-button downloaded PDF ("Three Bureau Credit Report")
 *   - Legacy ConsumerDirect single-bureau page (member.myfreescorenow.com/credit-report)
 *   - New SmartCredit-style web layout (app.myfreescorenow.com)
 */
export function parseFSNAny(text: string): CreditReport {
  // If we were handed HTML from the Classic View page, route to the 3B parser.
  if (looksLikeFSN3B(text)) return parseFSN3B(text);
  if (isFSNPdfFormat(text)) return parseFSNPDF(text);
  if (looksLikeFSNLegacy(text)) return parseFSNLegacy(text);
  return parseFSN(text);
}
export type {
  Account,
  AccountCategory,
  Bureau,
  BureauAccountDetail,
  BureauScores,
  BureauSummary,
  CreditReport,
  Inquiry,
  PaymentCode,
  PaymentHistoryEntry,
  PersonalInfo,
  Platform,
  PublicRecord,
  ReportSummary,
} from "./types.ts";
export { BUREAUS } from "./types.ts";
