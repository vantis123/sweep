/**
 * @sweep/dashboard — local Sweep dashboard.
 *
 * Single-page web app that runs on localhost. Student enters FSN/IIQ creds,
 * hits Pull. Sweep captures + parses the report. Student reviews flagged
 * negatives + personal info, picks reasons, hits Generate. Three Affidavit
 * of Truth PDFs are written to ./letters/{client}/ and returned as links.
 *
 *   npm run start    # → http://localhost:7879
 */

import express from "express";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

import {
  parseFSNAny,
  parseIIQ,
  extractIIQAccounts,
  listIIQDisputes,
  parseIIQPdf,
  listIIQPdfDisputes,
  type IIQAccount,
  type IIQDispute,
} from "@sweep/parsers";
import { readFile } from "node:fs/promises";
import { captureFSN, captureIIQ } from "@sweep/playwright-flows";
import {
  ACCOUNT_DISPUTE_REASONS,
  PERSONAL_INFO_DISPUTE_REASONS,
  BUREAU_CONTACTS,
  buildAffidavitInputs,
  listDisputables,
  listPersonalInfo,
  renderAffidavitHtml,
  type ClientInfo,
  type ItemSelection,
  type PersonalInfoSelection,
} from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");

const HOME = process.env.HOME || process.cwd();
const SANDBOX_DIR = resolve(HOME, ".sweep", "sandbox");

const PORT = Number(process.env.PORT ?? 7879);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/letters", express.static(LETTERS_DIR));

interface PullBody {
  platform: "fsn" | "iiq";
  username: string;
  password: string;
  last4?: string;
  /** Optional override. If omitted, the client name (and folder slug) come
   *  from the report's Personal Information section after capture. */
  clientName?: string;
  headed?: boolean;
}

interface GenerateBody {
  clientSlug: string;
  client: ClientInfo;
  itemSelections: ItemSelection[];
  personalInfoSelections: PersonalInfoSelection[];
  letterDate?: string;
  /** Path to the captured credit-report PDF (from /api/pull). If supplied,
   *  /api/generate drops a copy into the client letters folder so the student
   *  has the original report alongside the dispute letters. */
  capturedReportPath?: string;
}

app.get("/api/reasons", (_req, res) => {
  res.json({
    accountReasons: ACCOUNT_DISPUTE_REASONS,
    personalInfoReasons: PERSONAL_INFO_DISPUTE_REASONS,
    bureauContacts: BUREAU_CONTACTS,
  });
});

app.post("/api/pull", async (req, res) => {
  const body = req.body as PullBody;

  if (!body.platform || !body.username || !body.password) {
    return res.status(400).json({
      ok: false,
      stage: "validate",
      error: "platform, username, and password are required",
    });
  }

  await mkdir(SANDBOX_DIR, { recursive: true });

  try {
    const captureFn = body.platform === "fsn" ? captureFSN : captureIIQ;
    const cap = await captureFn({
      username: body.username,
      password: body.password,
      last4: body.last4,
      headed: body.headed ?? true,
      sandboxDir: SANDBOX_DIR,
    });

    if (!cap.ok || cap.text.length === 0) {
      return res.status(200).json({
        ok: false,
        stage: "capture",
        error: cap.error ?? "Empty capture — login may have failed.",
        warnings: cap.warnings,
      });
    }

    const noReportReason = detectNoActiveReport(cap.text);
    if (noReportReason) {
      return res.status(200).json({
        ok: false,
        stage: "no-active-report",
        error: noReportReason,
        warnings: cap.warnings,
      });
    }

    // IIQ branch: capture is a rendered PDF (from "Print this page" → page.pdf).
    // Parse it via pdfjs-dist for positional text extraction — that's how we
    // map values to TU/EX/EQ columns even when only one bureau has the account.
    if (body.platform === "iiq" && cap.pdfPath) {
      const pdfBuffer = await readFile(cap.pdfPath);
      const iiqReport = await parseIIQPdf(new Uint8Array(pdfBuffer));
      const iiqDisputes = listIIQPdfDisputes(iiqReport);
      if (iiqReport.accounts.length === 0) {
        return res.status(200).json({
          ok: false,
          stage: "empty-parse",
          error:
            "Could not find any accounts in the credit report PDF. Verify a real 3-bureau report is visible on screen in IIQ before trying again.",
          warnings: cap.warnings,
        });
      }
      const disputables = iiqDisputes.map((d, idx) => ({
        kind: "account" as const,
        id: `iiq-${idx}-${d.bureau}`,
        bureau: d.bureau,
        creditor: d.creditor,
        category: d.category,
        detail: d.detail,
      }));
      // Client name: prefer the report's extracted name, fall back to whatever
      // override the user supplied, last resort "client" (so slug is never empty).
      const fullName =
        iiqReport.personalInfo.fullName ||
        body.clientName ||
        "client";
      return res.json({
        ok: true,
        clientSlug: slug(fullName),
        capturedReportPath: cap.pdfPath, // so /api/generate can drop a copy in the client folder
        report: {
          platform: "iiq",
          reportDate: null,
          referenceNumber: null,
          totalAccounts: iiqReport.accounts.length,
          perBureauCounts: {
            transunion: iiqDisputes.filter((d) => d.bureau === "transunion").length,
            experian: iiqDisputes.filter((d) => d.bureau === "experian").length,
            equifax: iiqDisputes.filter((d) => d.bureau === "equifax").length,
          },
        },
        disputables,
        personalInfoCandidates: [], // parser doesn't surface PI dispute candidates yet — UI lets them add manually
        prefilledClient: {
          fullName,
          address: iiqReport.personalInfo.street,
          cityStateZip: iiqReport.personalInfo.cityStateZip,
          dob: iiqReport.personalInfo.dateOfBirth,
          // IIQ masks SSN — fall back to whatever the user entered on the
          // login form (we already have it in `body.last4`).
          ssnLast4: body.last4 ?? "",
        },
      });
    }

    // FSN branch: legacy text parser
    const report = parseFSNAny(cap.text);
    const totalAccounts = report.accounts.length;
    const totalInquiries = report.inquiries.length;
    if (totalAccounts === 0 && totalInquiries === 0) {
      return res.status(200).json({
        ok: false,
        stage: "empty-parse",
        error:
          "The captured page does not contain a parseable credit report. The most common cause is that the account does not have an active credit report pulled. Log into the platform manually, confirm a 3-bureau report is visible on screen, then try Sweep again.",
        warnings: cap.warnings,
      });
    }
    const disputables = listDisputables(report);
    const personalInfoCandidates = listPersonalInfo(report);
    const prefilledClient = prefillClient(report, body.clientName ?? "");
    // Slug from the extracted full legal name; fall back to override or "client".
    const slugBase = prefilledClient.fullName || body.clientName || "client";
    return res.json({
      ok: true,
      clientSlug: slug(slugBase),
      capturedReportPath: cap.pdfPath, // so /api/generate can drop a copy in the client folder
      report: {
        platform: report.platform,
        reportDate: report.reportDate,
        scores: report.scores,
        summary: report.summary,
      },
      disputables,
      personalInfoCandidates,
      prefilledClient,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      stage: "pipeline",
      error: (err as Error).message,
    });
  }
});

app.post("/api/generate", async (req, res) => {
  const body = req.body as GenerateBody;

  if (!body.client?.fullName) {
    return res.status(400).json({ ok: false, error: "client.fullName is required" });
  }
  if (
    (body.itemSelections?.length ?? 0) === 0 &&
    (body.personalInfoSelections?.length ?? 0) === 0
  ) {
    return res.status(400).json({
      ok: false,
      error: "Select at least one item or personal-info entry before generating letters.",
    });
  }

  const clientSlug = body.clientSlug || slug(body.client.fullName);
  const outDir = resolve(LETTERS_DIR, clientSlug);
  await mkdir(outDir, { recursive: true });

  // Drop a standalone copy of the breach screenshot in the client folder
  // alongside the letters (for visual reference even though it's embedded in
  // each letter PDF too).
  if (existsSync(BREACH_IMAGE_PATH)) {
    try {
      const breachCopy = resolve(outDir, "breach-screenshot.png");
      await readFile(BREACH_IMAGE_PATH).then((buf) =>
        import("node:fs/promises").then((fs) => fs.writeFile(breachCopy, buf))
      );
    } catch {}
  }
  // Copy the captured credit-report PDF if supplied
  if (body.capturedReportPath && existsSync(body.capturedReportPath)) {
    try {
      const reportCopy = resolve(outDir, "credit-report.pdf");
      await readFile(body.capturedReportPath).then((buf) =>
        import("node:fs/promises").then((fs) => fs.writeFile(reportCopy, buf))
      );
    } catch {}
  }

  try {
    const perBureau = buildAffidavitInputs({
      report: {
        platform: "fsn",
        reportDate: null,
        scores: { equifax: null, experian: null, transunion: null },
        summary: { equifax: {}, experian: {}, transunion: {} },
        accounts: [],
        inquiries: [],
        publicRecords: [],
        personalInfo: {},
        warnings: [],
        errors: [],
      },
      client: body.client,
      itemSelections: body.itemSelections ?? [],
      personalInfoSelections: body.personalInfoSelections ?? [],
      letterDate: body.letterDate,
    });

    const letters: Array<{ bureau: string; pdfUrl: string; pdfPath: string }> = [];
    const timestamp = Date.now();

    for (const { bureau, input } of perBureau) {
      const html = await renderAffidavitHtml(input);
      const fileName = `sweep-${clientSlug}-${bureau}-${timestamp}.pdf`;
      const outPath = resolve(outDir, fileName);

      await renderLetterPdf({
        html,
        fcra605bPath: FCRA_605B_PATH,
        breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
        outputPath: outPath,
      });

      letters.push({
        bureau,
        pdfPath: outPath,
        pdfUrl: `/letters/${clientSlug}/${fileName}`,
      });
    }

    return res.json({ ok: true, letters, outDir });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: (err as Error).message,
    });
  }
});

/**
 * Sniff the captured page text for obvious "no active report" states before
 * handing it to the parser. Returns a user-facing error string when the page
 * is clearly the IIQ/FSN landing or upsell, null when it looks like a real
 * report worth parsing.
 */
function detectNoActiveReport(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("subscription has expired") || lower.includes("renew your subscription")) {
    return "The credit-monitoring subscription is expired. Renew inside the client's account, then try Sweep again.";
  }
  if (lower.includes("we were unable to verify") || lower.includes("identity verification")) {
    return "The credit-monitoring portal is showing an identity-verification step that Sweep did not handle. Log in manually, complete the verification, leave the report visible on screen, then try Sweep again.";
  }
  // Real 3-bureau reports name every bureau dozens of times in the column headers
  // and account rows. Marketing/upsell pages name zero. A "Purchase Report" button
  // can appear on both, so don't gate on that — gate on the actual bureau-data signal.
  const bureauHits =
    Number(lower.includes("equifax")) +
    Number(lower.includes("experian")) +
    Number(lower.includes("transunion"));
  if (bureauHits < 3) {
    return `The captured page is not a 3-bureau report (found ${bureauHits} of 3 bureau names). The account may not have an active report pulled. Confirm a 3-bureau credit report is visible on screen in the portal, then try Sweep again.`;
  }
  return null;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "client"
  );
}

function prefillClientFromIIQ(accounts: IIQAccount[], fallbackName: string): ClientInfo {
  // v7 doesn't extract personal info from the Personal Information section yet.
  // For now, just use the fallback name. Student edits in UI.
  return {
    fullName: fallbackName,
    address: "",
    cityStateZip: "",
    dob: "",
    ssnLast4: "",
  };
}

function prefillClient(report: ReturnType<typeof parseFSNAny>, name: string): ClientInfo {
  const pi = report.personalInfo;
  // Pick the LONGEST non-empty value across bureaus (one bureau may carry a
  // middle initial that others lack, full ZIP+4 vs 5-digit, etc).
  const bestOf = (m?: Partial<Record<string, string>>): string => {
    if (!m) return "";
    const values = [m.transunion, m.experian, m.equifax].filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    );
    if (values.length === 0) return "";
    values.sort((a, b) => b.length - a.length);
    return values[0]!.trim();
  };
  const ssn = bestOf(pi.ssnLast4 as Partial<Record<string, string>>);
  const name0 = bestOf(pi.name as Partial<Record<string, string>>) || name;
  const addr = bestOf(pi.currentAddress as Partial<Record<string, string>>);
  // FSN format from parseFSN3B is "<street>, <city>, <ST> <zip>" with commas
  // joining the bureau's address-block lines. Split into street + city/state/zip.
  let address = addr;
  let cityStateZip = "";
  const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // City/state/zip is the last 1-2 parts depending on how FSN structured it.
    // If the last token looks like "STATE ZIP" use it as city/state/zip and the
    // rest is the street.
    const last = parts[parts.length - 1]!;
    if (/[A-Z]{2}\s*\d{5}/i.test(last)) {
      // "PALM BAY, FL 32907" → take last two parts joined
      cityStateZip = parts.slice(-2).join(", ");
      address = parts.slice(0, -2).join(", ");
      if (!address) {
        // Only 2 parts total: ["street", "city ST zip"]
        address = parts[0]!;
        cityStateZip = parts[1]!;
      }
    } else {
      address = parts.slice(0, -1).join(", ");
      cityStateZip = last;
    }
  }
  const birthYear = bestOf(pi.birthYear as Partial<Record<string, string>>);
  return {
    fullName: name0,
    address,
    cityStateZip,
    // FSN typically only shows the year — keep it as-is so the student
    // can see it and add MM/DD if needed.
    dob: birthYear,
    ssnLast4: ssn,
  };
}

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Sweep dashboard running at ${url}`);
  console.log(`  Sandbox:  ${SANDBOX_DIR}`);
  console.log(`  Letters:  ${LETTERS_DIR}\n`);

  if (process.env.SWEEP_NO_OPEN !== "1" && existsSync(PUBLIC_DIR)) {
    import("node:child_process").then(({ spawn }) => {
      try {
        let cmd: string;
        let args: string[];
        if (process.platform === "win32") {
          cmd = "cmd.exe";
          args = ["/c", "start", "", url];
        } else if (process.platform === "darwin") {
          cmd = "open";
          args = [url];
        } else {
          cmd = "xdg-open";
          args = [url];
        }
        const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false });
        child.on("error", () => {});
        child.unref();
      } catch {}
    }).catch(() => {});
  }
});
