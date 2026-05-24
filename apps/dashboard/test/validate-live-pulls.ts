/**
 * Live-pull validation. For each named client, hit the actual monitoring portal
 * (IIQ or FSN) via the same playwright flows Bank uses, run the appropriate
 * parser, and dump per-bureau negatives to JSON so we can eyeball-diff against
 * Phillip's Drive Client Files.
 *
 *   SUPABASE_URL=... SUPABASE_KEY=... \
 *     NAMES='client-name-1,client-name-2,...' \
 *     npx tsx apps/dashboard/test/validate-live-pulls.ts
 */

import { chromium } from "playwright";
import {
  iiqLogin,
  fsnLogin,
  fsnCaptureReport,
} from "@sweep/playwright-flows";
import {
  extractIIQAccounts,
  listIIQDisputes,
  parseFSNAny,
  isNegativeCategory,
  categorizeBureau,
  type Bureau,
} from "@sweep/parsers";
import {
  BUREAU_CONTACTS,
  ACCOUNT_DISPUTE_REASONS,
  renderAffidavitHtml,
  type AffidavitItem,
} from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");

const SANDBOX_DIR = resolve(homedir(), ".sweep", "validate");
const OUT_DIR = "/tmp/sweep-validation";
const BAD_CREDS_FILE = resolve(OUT_DIR, "bad-creds.txt");

function isCredentialError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("invalid login") ||
    m.includes("invalid username") ||
    m.includes("invalid password") ||
    m.includes("incorrect password") ||
    m.includes("wrong credentials") ||
    m.includes("account locked") ||
    m.includes("temporarily locked")
  );
}

function loadBadCreds(): Set<string> {
  if (!existsSync(BAD_CREDS_FILE)) return new Set();
  return new Set(
    readFileSync(BAD_CREDS_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function markBadCreds(username: string, reason: string): Promise<void> {
  await appendFile(
    BAD_CREDS_FILE,
    `${username.toLowerCase()}\t${new Date().toISOString()}\t${reason.replace(/\s+/g, " ").slice(0, 120)}\n`,
  );
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";

interface Client {
  name: string;
  monitoringPlatform: "identityiq" | "freescorenow";
  monitoringUsername: string;
  monitoringPassword: string;
  ssnLast4: string | null;
  status: string;
}

interface PerBureauNegative {
  creditor: string;
  accountNumber: string;
  dateOpened?: string;
  balance?: string;
  category: string;
  status?: string;
}

interface PerClientResult {
  name: string;
  platform: "identityiq" | "freescorenow";
  ok: boolean;
  error?: string;
  perBureau: Record<Bureau, PerBureauNegative[]>;
  totalAccounts?: number;
}

async function fetchClients(filter: string[]): Promise<Client[]> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/Client?select=name,monitoringPlatform,monitoringUsername,monitoringPassword,ssnLast4,status&isActive=eq.true&status=eq.ACTIVE&monitoringUsername=not.is.null&monitoringPassword=not.is.null`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  const all: Client[] = await r.json();
  const out: Client[] = [];
  for (const needle of filter) {
    const found = all.find((c) =>
      c.name.toLowerCase().includes(needle.trim().toLowerCase()),
    );
    if (found) out.push(found);
    else console.log(`  ⚠ no match in Supabase for '${needle}'`);
  }
  return out;
}

async function pullIIQ(client: Client): Promise<PerClientResult> {
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--window-size=1920,1200",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  const ctx = {
    page,
    context,
    sandboxDir: SANDBOX_DIR,
    log: (m: string) => console.log(`       ${m}`),
    warnings: [] as string[],
    screenshots: [] as string[],
  };
  const result: PerClientResult = {
    name: client.name,
    platform: "identityiq",
    ok: false,
    perBureau: { transunion: [], experian: [], equifax: [] },
  };
  try {
    await iiqLogin(
      ctx,
      client.monitoringUsername,
      client.monitoringPassword,
      client.ssnLast4 ?? undefined,
    );
    await sleep(2500);
    for (let i = 0; i < 6; i++) {
      const target = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
        const el = all.find((e) => {
          const raw = (e.textContent ?? "").trim();
          if (
            !(
              raw.toLowerCase() === "no thanks" ||
              raw.toLowerCase() === "no thanks →"
            )
          )
            return false;
          if (raw.length > 30) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!target) break;
      await page.mouse.click(target.x, target.y);
      await sleep(900);
    }
    await sleep(1500);
    // Always force navigation to /CreditReport.aspx — that's the canonical
    // full-report page. The dashboard "View Latest Report" link lands on a
    // summary page that only shows the top N accounts.
    await page.goto("https://member.identityiq.com/CreditReport.aspx", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }).catch(() => {});
    console.log(`       -> after nav URL: ${page.url()}`);
    await sleep(4000);

    // No scroll needed — page.pdf() renders the entire DOM (off-screen
    // included). We parse the resulting PDF text directly for account
    // fields and payment history, so we don't depend on Angular finishing
    // its lazy renders in the live DOM.

    // Capture the LIVE rendered HTML (Angular fully populated) — this is the
    // version that has the colored payment-history grid filled in with real
    // status codes, not the unrendered template the "Download this report"
    // path gives us.
    const html = await page.content();
    const htmlPath = `${SANDBOX_DIR}/iiq-rendered-${slug(client.name)}-${Date.now()}.html`;
    await writeFile(htmlPath, html);

    // We'll parse all account data from the PDF below (no DOM dependence).

    // Render the same page as a PDF. Use IIQ's "Print this page" link which
    // calls their PrintPage() function (prepares a print-friendly view).
    // First override window.print so the OS print dialog never appears.
    await page.evaluate(() => {
      // @ts-ignore
      (window as any).print = () => {};
    });
    // Click "Print this page" — triggers IIQ's PrintPage() which expands all
    // account blocks for printing.
    try {
      await page
        .locator('a:has-text("Print this page")')
        .first()
        .click({ timeout: 5000 });
      await sleep(3000);
    } catch (e) {
      console.log(`       -> "Print this page" click skipped: ${(e as Error).message.split("\n")[0]}`);
    }
    // Generate PDF in print media. scale=0.6 keeps each row compact so
    // Chromium can fit the huge IIQ report into its PDF size limits.
    const pdfPath = `${SANDBOX_DIR}/iiq-rendered-${slug(client.name)}-${Date.now()}.pdf`;
    await page.emulateMedia({ media: "print" });
    try {
      await page.pdf({
        path: pdfPath,
        format: "Letter",
        printBackground: true,
        scale: 0.6,
        margin: { top: "0.3in", bottom: "0.3in", left: "0.3in", right: "0.3in" },
      });
      console.log(`       -> wrote PDF to ${pdfPath}`);
      // Stash so the letters-generation step downstream can copy it.
      (result as PerClientResult & { _pdfPath?: string })._pdfPath = pdfPath;
    } catch (e) {
      console.log(`       -> PDF generation failed: ${(e as Error).message.split("\n")[0]}`);
    }

    // Parse account data from the PDF using pdfjs-dist for positional text
    // info. The x-coordinate of each value tells us which bureau column it
    // belongs to (TU/EX/EQ) — even when other columns are empty.
    type PdfAccount = {
      creditor: string;
      perBureau: Record<Bureau, { fields: Record<string, string>; historyWorstLate: number; hasData: boolean }>;
    };
    const pdfAccounts: PdfAccount[] = [];
    const bureauKeys: Bureau[] = ["transunion", "experian", "equifax"];
    const stashedPdf = (result as PerClientResult & { _pdfPath?: string })._pdfPath;
    if (stashedPdf && existsSync(stashedPdf)) {
      try {
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const pdfBuf = await readFile(stashedPdf);
        const doc = await getDocument({ data: new Uint8Array(pdfBuf) }).promise;
        type TI = { text: string; x: number; y: number; page: number };
        const items: TI[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const pg = await doc.getPage(p);
          const tc = await pg.getTextContent();
          for (const it of tc.items as any[]) {
            const text = (it.str ?? "").trim();
            if (!text) continue;
            items.push({ text, x: it.transform[4], y: it.transform[5], page: p });
          }
        }
        // Group items into lines (same page, similar y)
        const sorted = [...items].sort((a, b) => {
          if (a.page !== b.page) return a.page - b.page;
          if (Math.abs(a.y - b.y) > 3) return b.y - a.y;
          return a.x - b.x;
        });
        const lines: TI[][] = [];
        let cur: TI[] = [];
        let lastY: number | null = null, lastPage: number | null = null;
        for (const it of sorted) {
          if (lastPage !== it.page || lastY === null || Math.abs(it.y - lastY) > 3) {
            if (cur.length > 0) lines.push(cur);
            cur = [];
          }
          cur.push(it);
          lastY = it.y;
          lastPage = it.page;
        }
        if (cur.length > 0) lines.push(cur);
        // Find bureau column x-positions from the header line
        let cols = { tu: 170, ex: 283, eq: 394 };
        for (const line of lines) {
          const tu = line.find((it) => /^TransUnion$/i.test(it.text));
          const ex = line.find((it) => /^Experian$/i.test(it.text));
          const eq = line.find((it) => /^Equifax$/i.test(it.text));
          if (tu && ex && eq) { cols = { tu: tu.x, ex: ex.x, eq: eq.x }; break; }
        }
        const bureauFromX = (x: number): Bureau => {
          const d = [
            { b: "transunion" as Bureau, v: Math.abs(x - cols.tu) },
            { b: "experian" as Bureau, v: Math.abs(x - cols.ex) },
            { b: "equifax" as Bureau, v: Math.abs(x - cols.eq) },
          ];
          d.sort((a, b) => a.v - b.v);
          return d[0].b;
        };
        // Chunk by account: creditor line precedes the bureau header
        type Chunk = TI[][];
        const accountChunks: Chunk[] = [];
        let chunk: Chunk = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const text = line.map((it) => it.text).join(" ");
          const hasTu = /\bTransUnion\b/.test(text);
          const hasEx = /\bExperian\b/.test(text);
          const hasEq = /\bEquifax\b/.test(text);
          const isHeader = hasTu && hasEx && hasEq && line.length >= 3 && line.length <= 8;
          if (isHeader && i > 0) {
            const prev = lines[i - 1];
            const prevText = prev.map((it) => it.text).join(" ").trim();
            if (prevText && !/:$/.test(prevText.trim()) && !/^\s*Two-Year/i.test(prevText)) {
              if (chunk.length > 1) accountChunks.push(chunk.slice(0, -1));
              chunk = [prev, line];
              continue;
            }
          }
          chunk.push(line);
        }
        if (chunk.length > 0) accountChunks.push(chunk);

        for (const ch of accountChunks) {
          if (ch.length < 3) continue;
          const credLine = ch[0];
          const headerLine = ch[1];
          const creditor = credLine.map((it) => it.text).join(" ").replace(/\s+/g, " ").trim();
          if (!creditor || /^Account #/i.test(creditor)) continue;
          const headerText = headerLine.map((it) => it.text).join(" ");
          if (!/TransUnion/i.test(headerText) || !/Experian/i.test(headerText) || !/Equifax/i.test(headerText)) continue;

          const perBureau = {
            transunion: { fields: {} as Record<string, string>, historyWorstLate: 0, hasData: false },
            experian: { fields: {} as Record<string, string>, historyWorstLate: 0, hasData: false },
            equifax: { fields: {} as Record<string, string>, historyWorstLate: 0, hasData: false },
          };
          let inHistory = false;
          for (let li = 2; li < ch.length; li++) {
            const line = ch[li];
            const lineText = line.map((it) => it.text).join(" ");
            if (/Two-Year payment history/i.test(lineText)) { inHistory = true; continue; }
            if (inHistory) {
              const bureauItem = line.find((it) => /^(TransUnion|Experian|Equifax)$/i.test(it.text));
              if (!bureauItem) continue;
              const bureau = bureauItem.text.toLowerCase() as Bureau;
              let worst = 0;
              for (const it of line) {
                if (it === bureauItem) continue;
                if (!/^\d+$/.test(it.text)) continue;
                const n = parseInt(it.text, 10);
                if (n === 30 || n === 60 || n === 90 || n === 120 || n === 150 || n === 180) {
                  if (n > worst) worst = n;
                }
              }
              perBureau[bureau].historyWorstLate = worst;
              continue;
            }
            const labelItem = line.find((it) => /:$/.test(it.text));
            if (!labelItem) continue;
            const labelIdx = line.indexOf(labelItem);
            const label = labelItem.text.replace(/:$/, "").trim();
            if (label.length > 35) continue;
            for (let i = labelIdx + 1; i < line.length; i++) {
              const it = line[i];
              const text = it.text.trim();
              if (!text || text === "-") continue;
              const bureau = bureauFromX(it.x);
              if (!perBureau[bureau].fields[label]) {
                perBureau[bureau].fields[label] = text;
              }
            }
          }
          for (const b of bureauKeys) {
            const f = perBureau[b].fields;
            perBureau[b].hasData = !!(f["Account #"] || f["Account Number"] || Object.keys(f).length > 0);
          }
          pdfAccounts.push({ creditor, perBureau });
        }
        console.log(`       -> PDF parsed ${pdfAccounts.length} accounts (positional)`);
        await writeFile(
          resolve(OUT_DIR, `iiq-pdf-accounts-${slug(client.name)}.json`),
          JSON.stringify(pdfAccounts, null, 2),
        );
      } catch (e) {
        console.log(`       -> PDF parse failed: ${(e as Error).message}`);
      }
    }

    // Decide negative per bureau using current status + payment history.
    for (const a of pdfAccounts) {
      // Skip deferments
      const allComments = bureauKeys
        .map((b) => (a.perBureau[b].fields["Comments"] ?? "").toLowerCase())
        .join(" ");
      if (/(deferred|in deferment|forbearance)/.test(allComments)) continue;

      // Current status check per bureau. We look at Account Type, Account
      // Status, Payment Status, and Comments — any of these can flag negative.
      const statusLateRe = /(charge.?off|collection|repossess|foreclosure|bankrupt|late\s*\d+|derogatory|past\s*due)/i;
      const statusNegBureau: Record<Bureau, string | null> = {
        transunion: null, experian: null, equifax: null,
      };
      for (const b of bureauKeys) {
        if (!a.perBureau[b].hasData) continue;
        const f = a.perBureau[b].fields;
        const blob = `${f["Account Type"] ?? ""} ${f["Account Status"] ?? ""} ${f["Payment Status"] ?? ""} ${f["Comments"] ?? ""}`;
        if (!statusLateRe.test(blob)) continue;
        if (/charge.?off/i.test(blob)) statusNegBureau[b] = "chargeoff";
        else if (/collection/i.test(blob)) statusNegBureau[b] = "collection";
        else if (/repossess/i.test(blob)) statusNegBureau[b] = "repossession";
        else if (/foreclosure/i.test(blob)) statusNegBureau[b] = "foreclosure";
        else if (/bankrupt/i.test(blob)) statusNegBureau[b] = "bankruptcy";
        else if (/derogatory/i.test(blob)) statusNegBureau[b] = "derogatory";
        else {
          const m = blob.match(/late\s*(\d+)/i);
          statusNegBureau[b] = m ? `late${m[1]}` : "late30";
        }
      }

      const anyStatusNeg = Object.values(statusNegBureau).some((c) => c !== null);
      const anyHistLate = bureauKeys.some((b) => a.perBureau[b].historyWorstLate > 0);
      if (!anyStatusNeg && !anyHistLate) continue;

      // Cross-bureau propagation: pick worst negative category to apply across bureaus
      let propagated: string | null = null;
      for (const c of Object.values(statusNegBureau)) {
        if (c) {
          propagated = c;
          break;
        }
      }
      const worstHistAny = Math.max(...bureauKeys.map((b) => a.perBureau[b].historyWorstLate));

      for (const b of bureauKeys) {
        if (!a.perBureau[b].hasData) continue;
        let cat: string;
        if (statusNegBureau[b]) cat = statusNegBureau[b]!;
        else if (a.perBureau[b].historyWorstLate > 0) cat = `late${a.perBureau[b].historyWorstLate}`;
        else if (propagated) cat = propagated;
        else if (worstHistAny > 0) cat = `late${worstHistAny}`;
        else continue;
        const f = a.perBureau[b].fields;
        result.perBureau[b].push({
          creditor: a.creditor,
          accountNumber: f["Account #"] ?? f["Account Number"] ?? "",
          dateOpened: f["Date Opened"] ?? "",
          balance: f["Balance"] ?? "",
          category: cat,
        });
      }
    }
    result.totalAccounts = pdfAccounts.length;
    result.ok = true;
  } catch (e) {
    result.error = (e as Error).message.split("\n")[0];
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

async function pullFSN(client: Client): Promise<PerClientResult> {
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--window-size=1920,1200",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  const ctx = {
    page,
    context,
    sandboxDir: SANDBOX_DIR,
    log: (m: string) => console.log(`       ${m}`),
    warnings: [] as string[],
    screenshots: [] as string[],
  };
  const result: PerClientResult = {
    name: client.name,
    platform: "freescorenow",
    ok: false,
    perBureau: { transunion: [], experian: [], equifax: [] },
  };
  try {
    await fsnLogin(ctx, client.monitoringUsername, client.monitoringPassword);
    const cap = await fsnCaptureReport(ctx);
    // Save raw captured text so we can inspect what FSN actually returned
    await writeFile(
      resolve(OUT_DIR, `fsn-raw-${slug(client.name)}.txt`),
      cap.text || "(no text captured)",
    );
    // Save HTML of the page right before parsing so we can see if there's an
    // FSN equivalent of IIQ's <ng-include tradeLinePartitionBasic> markers.
    try {
      const html = await page.content();
      await writeFile(
        resolve(OUT_DIR, `fsn-html-${slug(client.name)}.html`),
        html,
      );
    } catch {}
    // Also extract a list of all <a> and <button> texts visible on the
    // current page to see what selectors we'd need.
    const interactiveTexts = await page.evaluate(() => {
      const out: { tag: string; text: string }[] = [];
      for (const el of Array.from(document.querySelectorAll("a, button"))) {
        const t = (el.textContent ?? "").trim();
        if (t && t.length < 60) out.push({ tag: el.tagName, text: t });
      }
      return out;
    }).catch(() => []);
    await writeFile(
      resolve(OUT_DIR, `fsn-clickables-${slug(client.name)}.json`),
      JSON.stringify(interactiveTexts, null, 2),
    );
    const report = parseFSNAny(cap.text);
    for (const a of report.accounts) {
      for (const bureau of ["transunion", "experian", "equifax"] as Bureau[]) {
        const detail = a.bureaus[bureau];
        if (!detail) continue;
        const cat = categorizeBureau(detail);
        if (!isNegativeCategory(cat)) continue;
        result.perBureau[bureau].push({
          creditor: a.creditor,
          accountNumber: detail.accountNumber ?? "",
          dateOpened: detail.dateOpened ?? "",
          balance: detail.balance != null ? `$${detail.balance}` : "",
          category: cat,
          status: detail.paymentStatus ?? detail.accountStatus ?? "",
        });
      }
    }
    result.totalAccounts = report.accounts.length;
    result.ok = true;
  } catch (e) {
    result.error = (e as Error).message.split("\n")[0];
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(SANDBOX_DIR, { recursive: true });
  const filter = (process.env.NAMES ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (filter.length === 0) {
    console.error("Set NAMES=name1,name2,... env var");
    process.exit(1);
  }
  const clients = await fetchClients(filter);
  const badCreds = loadBadCreds();
  console.log(`\n  VALIDATING ${clients.length} CLIENT(S) LIVE\n`);
  if (badCreds.size > 0) {
    console.log(`  Skip list: ${badCreds.size} username(s) previously flagged as bad credentials`);
  }
  for (const c of clients) {
    const skipped = badCreds.has(c.monitoringUsername.toLowerCase()) ? " [SKIP — bad creds]" : "";
    console.log(`    ${c.name.padEnd(35)} ${c.monitoringPlatform.padEnd(14)} ${c.monitoringUsername}${skipped}`);
  }
  console.log();

  const results: PerClientResult[] = [];
  for (const client of clients) {
    console.log(`\n  === ${client.name} (${client.monitoringPlatform}) ===`);
    if (badCreds.has(client.monitoringUsername.toLowerCase())) {
      console.log(`    ⊘ skipped — credentials previously failed (see ${BAD_CREDS_FILE})`);
      results.push({
        name: client.name,
        platform: client.monitoringPlatform,
        ok: false,
        error: "skipped: bad creds on file",
        perBureau: { transunion: [], experian: [], equifax: [] },
      });
      continue;
    }
    const t0 = Date.now();
    const result =
      client.monitoringPlatform === "identityiq"
        ? await pullIIQ(client)
        : await pullFSN(client);
    if (!result.ok && result.error && isCredentialError(result.error)) {
      await markBadCreds(client.monitoringUsername, result.error);
      console.log(`    ⚠ marked ${client.monitoringUsername} as bad creds — will skip on future runs`);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.ok) {
      const tu = result.perBureau.transunion.length;
      const ex = result.perBureau.experian.length;
      const eq = result.perBureau.equifax.length;
      console.log(
        `    ✓ TU=${tu}  EX=${ex}  EQ=${eq}  (total accts seen=${result.totalAccounts})  (${elapsed}s)`,
      );
      console.log(`    --- TransUnion negatives ---`);
      result.perBureau.transunion.forEach((n) =>
        console.log(`      ${n.creditor}  ${n.accountNumber}  ${n.balance}  ${n.category}`),
      );
      console.log(`    --- Experian negatives ---`);
      result.perBureau.experian.forEach((n) =>
        console.log(`      ${n.creditor}  ${n.accountNumber}  ${n.balance}  ${n.category}`),
      );
      console.log(`    --- Equifax negatives ---`);
      result.perBureau.equifax.forEach((n) =>
        console.log(`      ${n.creditor}  ${n.accountNumber}  ${n.balance}  ${n.category}`),
      );
    } else {
      console.log(`    ✗ ${result.error}  (${elapsed}s)`);
    }
    results.push(result);
    await writeFile(
      resolve(OUT_DIR, `result-${slug(client.name)}.json`),
      JSON.stringify(result, null, 2),
    );

    // Generate 3 dispute letters (one per bureau) if we caught any negatives
    if (result.ok) {
      try {
        const clientSlug = slug(client.name);
        const outDir = resolve(LETTERS_DIR, clientSlug);
        await mkdir(outDir, { recursive: true });
        // Drop a standalone copy of the breach screenshot in the client folder
        // so the student can see it alongside the bundled PDFs.
        if (existsSync(BREACH_IMAGE_PATH)) {
          const breachCopy = resolve(outDir, "breach-screenshot.png");
          await readFile(BREACH_IMAGE_PATH).then((buf) => writeFile(breachCopy, buf));
        }
        // If we have a rendered-report PDF (IIQ flow), drop a copy in the
        // client folder so the student can view the original credit report
        // alongside the dispute letters.
        const renderedPdf = (result as PerClientResult & { _pdfPath?: string })._pdfPath;
        if (renderedPdf && existsSync(renderedPdf)) {
          const reportCopy = resolve(outDir, "credit-report.pdf");
          await readFile(renderedPdf).then((buf) => writeFile(reportCopy, buf));
        }
        const ts = Date.now();
        const dateStr = new Date().toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        });
        for (const bureau of ["transunion", "experian", "equifax"] as Bureau[]) {
          const negs = result.perBureau[bureau];
          if (negs.length === 0) continue;
          const items: AffidavitItem[] = negs.map((n) => ({
            creditor: n.creditor,
            detail: [
              n.accountNumber && `#${n.accountNumber}`,
              n.dateOpened && `opened ${n.dateOpened}`,
              n.balance && `Balance ${n.balance}`,
            ]
              .filter(Boolean)
              .join(" · "),
          }));
          const sharedReason = ACCOUNT_DISPUTE_REASONS.find((r) => r.id === "not-mine")!.text;
          const htmlContent = await renderAffidavitHtml({
            client: {
              fullName: client.name,
              address: "",
              cityStateZip: "",
              dob: "",
              ssnLast4: client.ssnLast4 ?? "",
            },
            bureau: BUREAU_CONTACTS[bureau],
            date: dateStr,
            items,
            personalInfoItems: [],
            sharedReason,
          });
          const outPath = resolve(outDir, `sweep-${clientSlug}-${bureau}-${ts}.pdf`);
          await renderLetterPdf({
            html: htmlContent,
            fcra605bPath: FCRA_605B_PATH,
            breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
            outputPath: outPath,
          });
          console.log(`    → wrote ${bureau} letter (${items.length} items) to ${outPath}`);
        }
      } catch (e) {
        console.log(`    ⚠ letter generation failed: ${(e as Error).message}`);
      }
    }
  }

  console.log(`\n\n  ╔═══════════════════════════════════════════════╗`);
  console.log(`  ║  VALIDATION SUMMARY                           ║`);
  console.log(`  ╚═══════════════════════════════════════════════╝`);
  for (const r of results) {
    if (r.ok) {
      const tu = r.perBureau.transunion.length;
      const ex = r.perBureau.experian.length;
      const eq = r.perBureau.equifax.length;
      console.log(
        `  ✓ ${r.name.padEnd(30)} ${r.platform.padEnd(14)} TU=${tu}  EX=${ex}  EQ=${eq}`,
      );
    } else {
      console.log(
        `  ✗ ${r.name.padEnd(30)} ${r.platform.padEnd(14)} ${r.error?.slice(0, 50)}`,
      );
    }
  }

  await writeFile(
    resolve(OUT_DIR, "all-results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(`\n  Wrote ${OUT_DIR}/all-results.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
