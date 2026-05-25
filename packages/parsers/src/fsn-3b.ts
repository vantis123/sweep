/**
 * MFSN 3B "Classic View" HTML parser.
 *
 * The Classic View page renders each account as a CSS Grid with 4 columns:
 *   col-start-1: field labels  ("Account #", "Balance Owed:", "Account Status:", ...)
 *   col-start-2: TransUnion values
 *   col-start-3: Experian values
 *   col-start-4: Equifax values
 *
 * Row position is encoded via row-start-N classes — label row N matches value
 * row N in each bureau column. Bureau values use "--" for missing.
 *
 * Account creditor name lives in the <strong data-uw-ignore-translate="true">
 * just before the grid.
 */

import * as cheerio from "cheerio";
import type {
  Account,
  AccountCategory,
  Bureau,
  BureauAccountDetail,
  CreditReport,
} from "./types.ts";
import {
  categorizeBureau,
  isNegativeCategory,
  parseDollar,
  rollupCategory,
} from "./shared.ts";

const BUREAUS: Bureau[] = ["transunion", "experian", "equifax"];

const COL_FOR_BUREAU: Record<Bureau, string> = {
  transunion: "col-start-2",
  experian: "col-start-3",
  equifax: "col-start-4",
};

/** Lowercased field-label -> BureauAccountDetail key. Labels not in this map
 *  are captured into rawFields so nothing is lost. */
const LABEL_MAP: Record<string, keyof BureauAccountDetail> = {
  "account #": "accountNumber",
  "account number": "accountNumber",
  "account status": "accountStatus",
  "payment status": "paymentStatus",
  "balance owed": "balance",
  "balance": "balance",
  "credit limit": "creditLimit",
  "high balance": "highCredit",
  "past due amount": "pastDue",
  "past due": "pastDue",
  "date opened": "dateOpened",
  "closed date": "dateClosed",
  "date reported": "lastReported",
  "creditor remarks": "comments",
  "account type": "accountType",
  "account description": "accountTypeDetail",
  "payment amount": "monthlyPayment",
  "last payment": "lastPayment",
};

function normalizeLabel(s: string): string {
  return s.replace(/[:]$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeValue(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t === "--" || t === "—" || t === "" ? "" : t;
}

/** True if the HTML looks like the FSN 3B Classic View page. */
export function looksLikeFSN3B(html: string): boolean {
  if (!/d-grid\s+grid-cols-4/i.test(html)) return false;
  if (!/bg-transunion/i.test(html)) return false;
  if (!/bg-experian/i.test(html)) return false;
  if (!/bg-equifax/i.test(html)) return false;
  return true;
}

export function parseFSN3B(html: string): CreditReport {
  const $ = cheerio.load(html);
  const accounts: Account[] = [];

  // Personal Information lives in its own d-grid grid-cols-4 near the top.
  // We identify it by the col-start-1 labels: it's the only grid that has
  // both "Name" and "Date of Birth" labels.
  const personalInfo: CreditReport["personalInfo"] = {};
  const piGrid = $("div.d-grid.grid-cols-4").filter((_, el) => {
    const labels = $(el)
      .find("p.grid-cell.col-start-1")
      .toArray()
      .map((l) => $(l).text().replace(/\s+/g, " ").trim().toLowerCase());
    return labels.some((l) => l.includes("name")) && labels.some((l) => l.includes("date of birth"));
  }).first();
  if (piGrid.length > 0) {
    const labelByRow = new Map<number, string>();
    piGrid.find("p.grid-cell.col-start-1").each((_, el) => {
      const cls = $(el).attr("class") || "";
      const m = cls.match(/row-start-(\d+)/);
      if (!m) return;
      // Personal-info label cells sometimes contain a <br> joining two labels
      // (e.g., "Name<br>Also Known As:") — split and pick the first.
      const raw = $(el).html() ?? "";
      const firstLabel = raw.split(/<br\s*\/?\s*>/i)[0] ?? "";
      const text = firstLabel.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text) labelByRow.set(parseInt(m[1]!, 10), text);
    });
    const piColForBureau: Record<Bureau, string> = {
      transunion: "col-start-2",
      experian: "col-start-3",
      equifax: "col-start-4",
    };
    for (const bureau of BUREAUS) {
      const col = piColForBureau[bureau];
      piGrid.find(`p.grid-cell.${col}`).each((_, el) => {
        const cls = $(el).attr("class") || "";
        const m = cls.match(/row-start-(\d+)/);
        if (!m) return;
        const row = parseInt(m[1]!, 10);
        if (row === 1) return; // bureau header
        const label = labelByRow.get(row);
        if (!label) return;
        // Convert <br> to newlines so multi-line values stay readable.
        const html = $(el).html() ?? "";
        const value = html
          .replace(/<br\s*\/?\s*>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/[ \t]+/g, " ")
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s !== "--")
          .join("\n");
        if (!value) return;
        if (label.startsWith("name")) {
          personalInfo.name = personalInfo.name ?? {};
          personalInfo.name[bureau] = value.split("\n")[0]!;
        } else if (label.startsWith("date of birth")) {
          personalInfo.birthYear = personalInfo.birthYear ?? {};
          // FSN often shows just the year (e.g., "1996") for DOB. Keep raw.
          personalInfo.birthYear[bureau] = value.split("\n")[0]!;
        } else if (label.startsWith("current address")) {
          personalInfo.currentAddress = personalInfo.currentAddress ?? {};
          // Join the lines with a comma so prefillClient can split on it.
          personalInfo.currentAddress[bureau] = value.replace(/\n/g, ", ");
        } else if (label.startsWith("previous address")) {
          personalInfo.previousAddresses = personalInfo.previousAddresses ?? {};
          personalInfo.previousAddresses[bureau] = value.split("\n");
        } else if (label.startsWith("employer")) {
          personalInfo.employer = personalInfo.employer ?? {};
          personalInfo.employer[bureau] = value.split("\n")[0]!;
        }
      });
    }
  }

  // Each account block: a <strong data-uw-ignore-translate="true">CREDITOR</strong>
  // followed by a <div class="d-grid grid-cols-4">…</div>. The strong sits inside
  // a <p>, which is a sibling of the grid div.
  const creditorStrongs = $('strong[data-uw-ignore-translate="true"]').toArray();

  for (const strong of creditorStrongs) {
    const $strong = $(strong);
    const creditor = $strong.text().replace(/\s+/g, " ").trim();
    if (!creditor) continue;
    // Skip bureau name strongs (the grid header cells use this attribute too)
    if (/^(transunion|experian|equifax)/i.test(creditor)) continue;

    // The grid is the next .d-grid sibling of the <p> ancestor of the strong.
    const $p = $strong.closest("p");
    const $grid = $p.nextAll("div.d-grid.grid-cols-4").first();
    if ($grid.length === 0) continue;

    // Build label-row map: row-start-N -> label
    const labelByRow = new Map<number, string>();
    $grid.find("p.grid-cell.col-start-1").each((_, el) => {
      const cls = $(el).attr("class") || "";
      const m = cls.match(/row-start-(\d+)/);
      if (!m) return;
      const row = parseInt(m[1]!, 10);
      const text = normalizeLabel($(el).text());
      if (text) labelByRow.set(row, text);
    });

    // Build per-bureau detail
    const perBureau: Partial<Record<Bureau, BureauAccountDetail>> = {};
    for (const bureau of BUREAUS) {
      const colClass = COL_FOR_BUREAU[bureau];
      const detail: BureauAccountDetail = {};
      let anyValue = false;
      $grid.find(`p.grid-cell.${colClass}`).each((_, el) => {
        const cls = $(el).attr("class") || "";
        const m = cls.match(/row-start-(\d+)/);
        if (!m) return;
        const row = parseInt(m[1]!, 10);
        // Row 1 is the bureau header label — skip
        if (row === 1) return;
        const label = labelByRow.get(row);
        if (!label) return;
        const value = normalizeValue($(el).text());
        if (!value) return;
        anyValue = true;
        const key = LABEL_MAP[label];
        if (!key) {
          // Unmapped label — keep it in rawFields for future use
          detail.rawFields = detail.rawFields ?? {};
          detail.rawFields[label] = value;
          return;
        }
        // Dollar fields → numeric, everything else → string
        if (key === "balance" || key === "creditLimit" || key === "highCredit" || key === "pastDue" || key === "monthlyPayment") {
          (detail as Record<string, unknown>)[key] = parseDollar(value);
        } else {
          (detail as Record<string, unknown>)[key] = value;
        }
      });
      if (anyValue) perBureau[bureau] = detail;
    }

    if (Object.keys(perBureau).length === 0) continue;

    // Two-Year Payment History scan — each account-wrapper (grid.parent.parent)
    // contains 3 .payment-history blocks under a "Two-Year Payment History"
    // heading. Status codes:
    //   status-C  badge "OK"   = Current
    //   status-U                = Unreported
    //   status-1  badge "30"   = 30 days late
    //   status-2  badge "60"   = 60 days late
    //   status-3  badge "90"   = 90 days late
    //   status-4  badge "120"  = 120 days late
    //   status-5+ badge "150+" = 150+ days late
    // Any month >= status-1 = historical delinquency. Phillip's team disputes
    // these even when current paymentStatus shows "Current".
    const historyByBureau: Record<Bureau, number> = {
      transunion: 0,
      experian: 0,
      equifax: 0,
    };
    const $accountWrapper = $grid.parent().parent();
    $accountWrapper.find("div.payment-history").each((_, ph) => {
      const $ph = $(ph);
      const heading = $ph.find(".payment-history-heading").text().toLowerCase();
      let bureau: Bureau | null = null;
      if (heading.includes("transunion")) bureau = "transunion";
      else if (heading.includes("experian")) bureau = "experian";
      else if (heading.includes("equifax")) bureau = "equifax";
      if (!bureau) return;
      let worst = 0;
      $ph.find('[class*="status-"]').each((_, cell) => {
        const cls = $(cell).attr("class") || "";
        const m = cls.match(/status-(\d+)/);
        if (m) worst = Math.max(worst, parseInt(m[1]!, 10));
      });
      historyByBureau[bureau] = Math.max(historyByBureau[bureau], worst);
    });

    // If payment history shows late marks but current paymentStatus is benign,
    // mutate paymentStatus on the per-bureau detail so downstream code that
    // re-categorizes via categorizeBureau() picks up the historical lateness.
    // Original paymentStatus is preserved in rawFields under "payment status (current)".
    const lateMap: Record<number, string> = {
      1: "Late 30 Days",
      2: "Late 60 Days",
      3: "Late 90 Days",
      4: "Late 120 Days",
      5: "Late 150 Days",
    };
    for (const bureau of BUREAUS) {
      const d = perBureau[bureau];
      if (!d) continue;
      const histLate = historyByBureau[bureau];
      if (histLate === 0) continue;
      const currentCat = categorizeBureau(d);
      if (isNegativeCategory(currentCat)) continue;
      const synthetic = lateMap[histLate] ?? "Late 30 Days";
      d.rawFields = d.rawFields ?? {};
      d.rawFields["payment status (current)"] = d.paymentStatus ?? "";
      d.rawFields["historical late from payment history"] = synthetic;
      d.paymentStatus = synthetic;
    }

    // Per-bureau category, then rollup
    const categories: Partial<Record<Bureau, AccountCategory>> = {};
    let isNegative = false;
    for (const bureau of BUREAUS) {
      const d = perBureau[bureau];
      if (!d) continue;
      const cat = categorizeBureau(d);
      categories[bureau] = cat;
      if (isNegativeCategory(cat)) isNegative = true;
    }
    const rolled = rollupCategory(categories);

    // Cross-bureau propagation: if any bureau on this account is negative,
    // mark all other bureaus where the account exists as negative too. Phillip
    // disputes on every bureau the account is reporting on, not just the ones
    // that happen to currently show lateness.
    if (isNegative) {
      // Pick the worst negative category seen on any bureau as the propagated
      // category for the others.
      const NEG_RANK: AccountCategory[] = [
        "chargeoff", "collection", "foreclosure", "repossession", "bankruptcy",
        "late150", "late120", "late90", "late60", "late30",
      ];
      let worst: AccountCategory | null = null;
      for (const cat of Object.values(categories)) {
        if (cat && isNegativeCategory(cat)) {
          if (worst === null || NEG_RANK.indexOf(cat) < NEG_RANK.indexOf(worst)) {
            worst = cat;
          }
        }
      }
      if (worst) {
        for (const bureau of BUREAUS) {
          const d = perBureau[bureau];
          if (!d) continue;
          const cat = categories[bureau];
          if (cat && isNegativeCategory(cat)) continue;
          // Propagate via paymentStatus mutation (same approach as history-late)
          const lateLabel = worst.startsWith("late")
            ? `Late ${worst.slice(4)} Days`
            : worst.charAt(0).toUpperCase() + worst.slice(1);
          d.rawFields = d.rawFields ?? {};
          d.rawFields["payment status (current)"] = d.rawFields["payment status (current)"] ?? d.paymentStatus ?? "";
          d.rawFields["propagated from another bureau"] = lateLabel;
          d.paymentStatus = lateLabel;
          categories[bureau] = worst;
        }
      }
    }

    accounts.push({
      creditor,
      category: rolled,
      isNegative,
      bureaus: perBureau,
    });
  }

  // Score extraction
  const scores = {
    transunion: parseScore($, "transunion"),
    experian: parseScore($, "experian"),
    equifax: parseScore($, "equifax"),
  };

  // Report date
  const reportDate = $("#report-switcher option[selected]").text().trim() || null;

  return {
    platform: "fsn",
    reportDate,
    referenceNumber: null,
    scores,
    summary: {
      transunion: {},
      experian: {},
      equifax: {},
    },
    accounts,
    inquiries: [],
    publicRecords: [],
    personalInfo,
    warnings: [],
    errors: [],
  };
}

function parseScore($: cheerio.CheerioAPI, bureau: Bureau): number | null {
  // The hero block shows scores like:
  //   <... bg-transunion ...>...</...>   544
  // The score is a <span> or text node near the bureau-colored badge.
  // Fall back to any 3-digit number near the bureau name on the page.
  const text = $("body").text();
  const re = new RegExp(`${bureau}[^\\d]{0,40}(\\d{3})`, "i");
  const m = text.match(re);
  return m && m[1] ? parseInt(m[1]!, 10) : null;
}
