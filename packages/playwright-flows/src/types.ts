/**
 * Shared types for @sweep/playwright-flows.
 */

import type { Page, BrowserContext } from "playwright";

export type Platform = "fsn" | "iiq";

export type CaptureSource =
  | "fsn-new"
  | "fsn-legacy-3b"
  | "fsn-legacy-equifax"
  | "fsn-print-popup"
  | "fsn-print-download"
  | "fsn-tradeline-loop"
  | "iiq-credit-report";

export interface CaptureCredentials {
  /** FSN/IIQ login email or username. */
  username: string;
  password: string;
  /** Required for IIQ when the security-question page appears. Ignored for FSN. */
  last4?: string;
}

export interface CaptureOptions extends CaptureCredentials {
  /** Show the browser window (default true). Skool-distributed users see the bot work. */
  headed?: boolean;
  /** Where intermediate artifacts (screenshots, archival PDFs) are saved. Default: cwd/.bank-sandbox */
  sandboxDir?: string;
  /** Forwarded to Playwright. */
  navigationTimeoutMs?: number;
  /** Optional log callback — defaults to console.log */
  onLog?: (line: string) => void;
}

export interface CaptureResult {
  ok: boolean;
  platform: Platform;
  source: CaptureSource;
  /** Raw report text — what gets piped into @sweep/parsers. */
  text: string;
  /** Path to a PDF artifact (when one was produced — print popup or download). */
  pdfPath?: string;
  /** Paths to debug screenshots saved in sandboxDir. */
  screenshots: string[];
  warnings: string[];
  /** Original URL where the report was pulled from. */
  reportUrl?: string;
  /** Diagnostic message when ok=false. */
  error?: string;
}

export interface FlowContext {
  page: Page;
  context: BrowserContext;
  sandboxDir: string;
  log: (line: string) => void;
  warnings: string[];
  screenshots: string[];
}
