#!/usr/bin/env node
/**
 * @sweep/mcp-server
 * -----------------
 * Stdio MCP server exposing Sweep as agentic tools that Claude Code (or any
 * MCP-aware client) can call.
 *
 *   sweep_pull_iiq_report     login → click View Latest Report → Download this report → save HTML
 *   sweep_extract_accounts    HTML → structured list of every account-detail table (raw data Claude reasons about)
 *   sweep_generate_letters    client info + per-bureau dispute selections → 3 dispute letter PDFs
 *
 * Add to ~/.claude/mcp.json:
 *   { "mcpServers": { "sweep": { "command": "node", "args": ["/Users/Krownz/sweep/apps/mcp-server/src/index.ts"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import {
  extractIIQAccounts,
  listIIQDisputes,
  BUREAUS as IIQ_BUREAUS,
  parseIIQPdf,
  listIIQPdfDisputes,
} from "@sweep/parsers";
import { captureIIQ } from "@sweep/playwright-flows";
import {
  BUREAU_CONTACTS,
  ACCOUNT_DISPUTE_REASONS,
  renderAffidavitHtml,
  type AffidavitItem,
} from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";
import type { Bureau } from "@sweep/parsers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");

const HOME = process.env.HOME || process.cwd();
const DEFAULT_SANDBOX = resolve(HOME, ".sweep", "sandbox");

const server = new McpServer(
  { name: "sweep", version: "0.0.1" },
  {
    instructions: [
      "Sweep is Arvantis Tech's dispute-letter agent. It logs into a client's",
      "IdentityIQ account, renders the 3-bureau credit report as a PDF (via",
      "page.pdf() after clicking 'Print this page'), extracts every account,",
      "and generates three Affidavit of Truth dispute letters (one per bureau)",
      "ready to print and mail certified.",
      "",
      "AGENT WORKFLOW (recommended):",
      "  1. Call `sweep_pull_iiq_report` with the client's IIQ credentials.",
      "     Returns a PDF path of the rendered credit report.",
      "  2. Call `sweep_extract_accounts` on the PDF path.",
      "     Returns every account-detail listing with creditor name, per-bureau",
      "     columns (TU/EX/EQ), Account #, Status, Payment Status, payment-",
      "     history late marks (30/60/90/120/150/180-day buckets), and a list",
      "     of pre-computed dispute targets per bureau. Bureau attribution is",
      "     based on x-coordinate of each value in the PDF (via pdfjs-dist).",
      "  3. Review the disputes list; apply rules below to add/remove items.",
      "  4. Call `sweep_generate_letters` with client personal info and your",
      "     per-bureau dispute selections. Returns 3 PDF paths + breach.png",
      "     + credit-report.pdf in the client folder.",
      "",
      "DISPUTE-SELECTION RULES (already applied by sweep_extract_accounts):",
      "  - Negative indicators in Account Type / Account Status / Payment",
      "    Status / Comments → dispute:",
      "      • Collection / Chargeoff",
      "      • Derogatory",
      "      • Foreclosure / Repossession / Bankruptcy",
      "      • Late 30/60/90/120/150/180 Days",
      "      • Past due",
      "  - Two-Year payment-history late marks (any month with 30+) → dispute",
      "    even if current status is 'Current' (closed accounts often hide",
      "    historical lates this way).",
      "  - Skip deferments (Comments mentions 'deferred' / 'in deferment' /",
      "    'forbearance') — these aren't disputed.",
      "  - Cross-bureau propagation: if any bureau is negative, propagate to",
      "    all bureaus where the account is reporting.",
      "  - Don't dispute inquiries via this tool.",
      "  - Keep creditor names exactly as IIQ shows them per bureau (don't",
      "    canonicalize — each bureau may have its own naming, and collection",
      "    accounts often appear as '(Original Creditor: NAME)').",
      "",
      "NOTE: All processing is local. No client data leaves the user's machine.",
    ].join("\n"),
  }
);

// ───────────── Tool 1: sweep_pull_iiq_report ──────────────────────────

server.registerTool(
  "sweep_pull_iiq_report",
  {
    title: "Pull IIQ credit report",
    description:
      "Logs into IdentityIQ in a real browser (headed by default), navigates to the " +
      "full credit report at /CreditReport.aspx, clicks 'Print this page' to expand " +
      "all accounts, then renders the page as a vector PDF via page.pdf(). Returns " +
      "the PDF path. Bot-detection bypass for IIQ's navigator.webdriver is applied " +
      "automatically.",
    inputSchema: {
      username: z.string().describe("IIQ login email/username"),
      password: z.string().describe("IIQ password"),
      last4: z.string().describe("Last 4 of SSN — IIQ security challenge"),
      headed: z.boolean().default(true).describe("Show browser (recommended)"),
      sandboxDir: z.string().optional().describe(`Where to save files (default: ${DEFAULT_SANDBOX})`),
    },
  },
  async (args) => {
    const sandboxDir = args.sandboxDir ?? DEFAULT_SANDBOX;
    await mkdir(sandboxDir, { recursive: true });
    const cap = await captureIIQ({
      username: args.username,
      password: args.password,
      last4: args.last4,
      headed: args.headed,
      sandboxDir,
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: cap.ok,
          pdfPath: cap.pdfPath,
          textLength: cap.text.length,
          source: cap.source,
          warnings: cap.warnings,
          error: cap.error,
          reportUrl: cap.reportUrl,
        }, null, 2),
      }],
    };
  }
);

// ───────────── Tool 2: sweep_extract_accounts ────────────────────────
//   Parses the IIQ credit-report PDF (rendered via page.pdf() after clicking
//   "Print this page") into structured per-account, per-bureau data. Uses
//   pdfjs-dist for positional text extraction — that's how we map values to
//   TU/EX/EQ columns even when only one bureau has the account.

server.registerTool(
  "sweep_extract_accounts",
  {
    title: "Extract every account from credit report PDF",
    description:
      "Reads the IIQ credit-report PDF and returns every account with per-bureau " +
      "fields (Account #, Account Status, Payment Status, Comments, Balance, etc.) " +
      "and payment-history late marks (30/60/90/120/150/180-day buckets). " +
      "Negatives are detected from Account Type 'Collection', Account Status " +
      "'Derogatory', Payment Status 'Chargeoff/Late N Days', Comments, AND the " +
      "Two-Year payment-history grid. Cross-bureau propagation: if any bureau is " +
      "negative, all bureaus where the account is reporting get marked negative. " +
      "Deferments (student loans in 'Payment deferred') are excluded per Phillip's " +
      "rule.",
    inputSchema: {
      pdfPath: z.string().describe("Path to the rendered credit-report PDF"),
    },
  },
  async (args) => {
    if (!existsSync(args.pdfPath)) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `File not found: ${args.pdfPath}` }) }] };
    }
    const pdfBuffer = await readFile(args.pdfPath);
    const report = await parseIIQPdf(new Uint8Array(pdfBuffer));
    const disputes = listIIQPdfDisputes(report);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          totalAccounts: report.accounts.length,
          totalNegativePerBureauDisputes: disputes.length,
          perBureauCounts: {
            transunion: disputes.filter((d) => d.bureau === "transunion").length,
            experian: disputes.filter((d) => d.bureau === "experian").length,
            equifax: disputes.filter((d) => d.bureau === "equifax").length,
          },
          accounts: report.accounts,
          disputes,
        }, null, 2),
      }],
    };
  }
);

// ───────────── Tool 3: sweep_generate_letters ────────────────────────

const ClientInfoSchema = z.object({
  fullName: z.string(),
  address: z.string().default(""),
  cityStateZip: z.string().default(""),
  dob: z.string().default(""),
  ssnLast4: z.string().default(""),
});

const DisputeItemSchema = z.object({
  creditor: z.string().describe("Use IIQ's name exactly as shown for this bureau"),
  detail: z.string().describe("E.g., '#49857**** · opened 08/01/2019 · Balance $3,300.00'"),
  reasonId: z.string().optional().describe("One of: not-mine, unauthorized-inquiry, fraudulent-account, data-breach, block-605b, inaccurate-payment-history, collection-never-validated, chargeoff-not-mine, public-record-not-mine, duplicate-account. Default: not-mine."),
  customReasonText: z.string().optional().describe("Override reasonId with your own text"),
});

const PerBureauDisputeSchema = z.object({
  bureau: z.enum(["transunion", "experian", "equifax"]),
  items: z.array(DisputeItemSchema),
});

server.registerTool(
  "sweep_generate_letters",
  {
    title: "Generate Affidavit of Truth letters per bureau",
    description:
      "Renders 3 dispute letter PDFs (one per bureau) containing the disputes you selected. " +
      "Each letter is an Affidavit of Truth that includes the FCRA §605B statute and a breach " +
      "screenshot bundled in. Returns the PDF paths.",
    inputSchema: {
      clientSlug: z.string().describe("Used as folder name under letters/ (e.g., 'kelly-michonda')"),
      client: ClientInfoSchema,
      perBureauDisputes: z.array(PerBureauDisputeSchema),
      letterDate: z.string().optional().describe("Defaults to today"),
    },
  },
  async (args) => {
    const dateStr = args.letterDate || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const outDir = resolve(LETTERS_DIR, args.clientSlug);
    await mkdir(outDir, { recursive: true });
    const timestamp = Date.now();
    const out: Array<{ bureau: string; pdfPath: string; sizeKB: number; itemCount: number }> = [];
    for (const group of args.perBureauDisputes) {
      const items: AffidavitItem[] = group.items.map((it) => {
        const resolved = it.customReasonText
          ?? ACCOUNT_DISPUTE_REASONS.find((r) => r.id === (it.reasonId ?? "not-mine"))?.text
          ?? ACCOUNT_DISPUTE_REASONS[0].text;
        return { creditor: it.creditor, detail: it.detail, reasonText: resolved };
      });
      if (items.length === 0) continue;
      const html = await renderAffidavitHtml({
        client: args.client,
        bureau: BUREAU_CONTACTS[group.bureau as Bureau],
        date: dateStr,
        items,
        personalInfoItems: [],
      });
      const fileName = `sweep-${args.clientSlug}-${group.bureau}-${timestamp}.pdf`;
      const outPath = resolve(outDir, fileName);
      await renderLetterPdf({
        html,
        fcra605bPath: FCRA_605B_PATH,
        breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
        outputPath: outPath,
      });
      out.push({
        bureau: group.bureau,
        pdfPath: outPath,
        sizeKB: Math.round(statSync(outPath).size / 1024 * 10) / 10,
        itemCount: items.length,
      });
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, outDir, letters: out }, null, 2),
      }],
    };
  }
);

// ───────────── start ─────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
