import type {
  Account,
  AccountCategory,
  Bureau,
  BureauAccountDetail,
  CreditReport,
  Inquiry,
  PublicRecord,
} from "@sweep/parsers";

export type DisputableKind = "account" | "inquiry" | "public-record";

export interface DisputableItem {
  kind: DisputableKind;
  id: string;
  bureau: Bureau;
  creditor: string;
  category: AccountCategory | string;
  detail: string;
}

const LATE_CATEGORIES: ReadonlySet<AccountCategory> = new Set<AccountCategory>([
  "late30",
  "late60",
  "late90",
  "late120",
  "late150",
]);

function isClosed(detail: BureauAccountDetail | undefined): boolean {
  if (!detail) return false;
  if (detail.dateClosed && detail.dateClosed.trim().length > 0) return true;
  const c = (detail.accountCondition ?? "").toUpperCase();
  if (c.includes("CLOSED")) return true;
  const s = (detail.accountStatus ?? "").toUpperCase();
  if (s.includes("CLOSED") || s.includes("PAID") || s.includes("TRANSFERRED")) return true;
  return false;
}

/**
 * Is the data this bureau reports for the account itself negative? Used to
 * filter per-bureau letter contents so each bureau letter only lists items
 * THAT BUREAU is actually reporting as negative — not items where another
 * bureau shows them negative.
 */
function isBureauDetailNegative(detail: BureauAccountDetail | undefined): boolean {
  if (!detail) return false;
  const fields = [
    detail.accountStatus ?? "",
    detail.paymentStatus ?? "",
    detail.comments ?? "",
    detail.accountCondition ?? "",
  ].join(" ").toLowerCase();
  if (!fields.trim()) return false;
  // Must have at least 1 substantive field to be considered "reporting"
  const hasSubstance =
    (detail.accountNumber && detail.accountNumber.length > 2) ||
    (detail.accountStatus && detail.accountStatus.length > 0) ||
    (detail.paymentStatus && detail.paymentStatus.length > 0);
  if (!hasSubstance) return false;
  return (
    fields.includes("collection") ||
    (fields.includes("charge") && fields.includes("off")) ||
    fields.includes("derogatory") ||
    fields.includes("foreclosure") ||
    fields.includes("repossession") ||
    fields.includes("bankruptcy") ||
    /\b(30|60|90|120|150)\s*days\s*late/.test(fields) ||
    /late\s*(30|60|90|120|150)\s*days/.test(fields)
  );
}

function anyBureauClosed(account: Account): boolean {
  return (
    isClosed(account.bureaus.experian) ||
    isClosed(account.bureaus.equifax) ||
    isClosed(account.bureaus.transunion)
  );
}

function isUnpaid(detail: BureauAccountDetail | undefined): boolean {
  if (!detail) return false;
  const status = (detail.accountStatus ?? "").toUpperCase();
  if (status.includes("PAID")) return false; // explicitly resolved
  const balance = detail.balance ?? 0;
  const pastDue = detail.pastDue ?? 0;
  return balance > 0 || pastDue > 0;
}

function anyBureauUnpaid(account: Account): boolean {
  return (
    isUnpaid(account.bureaus.experian) ||
    isUnpaid(account.bureaus.equifax) ||
    isUnpaid(account.bureaus.transunion)
  );
}

function hasOriginalCreditorTag(account: Account): boolean {
  return /\(\s*Original\s*Creditor/i.test(account.creditor);
}

function normalizeCreditorPrefix(name: string): string {
  return name
    .toUpperCase()
    .replace(/\s*\(.*?\)\s*/g, "") // strip any parenthetical (incl "(Original Creditor: …)")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

/**
 * Auto-dispute rule. Mirrors Phillip's manual selection criteria from
 * Kelly Michonda's Round 1 file (May 2026):
 *   - Chargeoffs / foreclosures / repos / bankruptcies → flag, EXCEPT skip
 *     a chargeoff lacking "(Original Creditor: …)" if another chargeoff
 *     entry exists that DOES have the tag and shares the same creditor-name
 *     prefix (e.g., drop "SPRINGOAKS" when "SPRINGOAKCAP (Original
 *     Creditor: Celtic Bank)" is also present — same underlying debt).
 *   - Collections → only if the creditor name carries an "(Original
 *     Creditor: …)" tag. Without that, the entry is typically a duplicate
 *     or furnisher-side listing.
 *   - Late-payment categories → only on CLOSED accounts (flag regardless of
 *     paid status — historical lates still hurt the score per Phillip).
 *   - Anything else with isNegative=true → only if closed.
 */
function isAccountAutoDisputable(account: Account, allAccounts: readonly Account[]): boolean {
  if (
    account.category === "chargeoff" ||
    account.category === "foreclosure" ||
    account.category === "repossession" ||
    account.category === "bankruptcy"
  ) {
    if (!hasOriginalCreditorTag(account)) {
      // Skip if this looks like a no-OC duplicate of an OC-tagged entry
      const myPrefix = normalizeCreditorPrefix(account.creditor);
      const ocDup = allAccounts.some(
        (other) =>
          other !== account &&
          hasOriginalCreditorTag(other) &&
          normalizeCreditorPrefix(other.creditor).startsWith(myPrefix.slice(0, 6)),
      );
      if (ocDup) return false;
    }
    return true;
  }
  if (account.category === "collection") {
    return hasOriginalCreditorTag(account);
  }
  if (LATE_CATEGORIES.has(account.category)) {
    return anyBureauClosed(account);
  }
  if (account.isNegative && account.category !== "current") {
    return anyBureauClosed(account);
  }
  return false;
}

function categoryLabel(category: AccountCategory | string): string {
  const map: Record<string, string> = {
    collection: "Collection",
    chargeoff: "Charge-Off",
    foreclosure: "Foreclosure",
    repossession: "Repossession",
    bankruptcy: "Bankruptcy",
    late30: "30 Days Late",
    late60: "60 Days Late",
    late90: "90 Days Late",
    late120: "120 Days Late",
    late150: "150 Days Late",
    settled: "Settled",
    transferred: "Transferred",
    closed: "Closed",
    current: "Current",
  };
  return map[category] ?? String(category);
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Return every disputable item in the report (negative accounts, hard inquiries,
 * public records), expanded per-bureau. One Account that reports on all three
 * bureaus becomes three DisputableItems — one per bureau — because each bureau
 * letter only lists the items that bureau is reporting.
 */
export function listDisputables(report: CreditReport): DisputableItem[] {
  const items: DisputableItem[] = [];

  report.accounts.forEach((account, accountIdx) => {
    if (!isAccountAutoDisputable(account, report.accounts)) return;
    const baseId = safeSlug(account.creditor) || `account-${accountIdx}`;
    for (const bureau of ["experian", "equifax", "transunion"] as Bureau[]) {
      const detail = account.bureaus[bureau];
      if (!detail) continue;
      // Per-bureau negativity filter: TEMPORARILY DISABLED until parser's
      // per-bureau attribution is rebuilt with account-number-based grouping.
      // The HTML's data attribution across bureaus is too noisy for the
      // current sub_header walker to reliably tell which bureau reports an
      // account. Show on all bureaus, let the user uncheck in the UI.
      // if (!isBureauDetailNegative(detail)) continue;
      const accountStatus = detail.paymentStatus ?? detail.accountStatus ?? "";
      const accountNum = detail.accountNumber ? `#${detail.accountNumber}` : "";
      const opened = detail.dateOpened ? `opened ${detail.dateOpened}` : "";
      items.push({
        kind: "account",
        id: `account-${baseId}-${bureau}-${accountIdx}`,
        bureau,
        creditor: account.creditor,
        category: account.category,
        detail: [
          categoryLabel(account.category),
          accountStatus,
          accountNum,
          opened,
        ]
          .filter((s) => s && s.length > 0)
          .join(" · "),
      });
    }
  });

  report.inquiries.forEach((inquiry: Inquiry, inquiryIdx) => {
    if (inquiry.type === "soft") return;
    const baseId = safeSlug(inquiry.creditor) || `inquiry-${inquiryIdx}`;
    items.push({
      kind: "inquiry",
      id: `inquiry-${baseId}-${inquiry.bureau}-${inquiryIdx}`,
      bureau: inquiry.bureau,
      creditor: inquiry.creditor,
      category: "Hard Inquiry",
      detail: inquiry.date ? `Hard inquiry · ${inquiry.date}` : "Hard inquiry",
    });
  });

  report.publicRecords.forEach((pr: PublicRecord, prIdx) => {
    items.push({
      kind: "public-record",
      id: `pubrec-${safeSlug(pr.type)}-${pr.bureau}-${prIdx}`,
      bureau: pr.bureau,
      creditor: pr.type,
      category: "Public Record",
      detail: [pr.type, pr.status, pr.date, pr.amount ? `$${pr.amount}` : ""]
        .filter(Boolean)
        .join(" · "),
    });
  });

  return items;
}

export interface PersonalInfoCandidate {
  id: string;
  field:
    | "currentAddress"
    | "previousAddress"
    | "name"
    | "employer"
    | "phone"
    | "ssn"
    | "birthYear";
  bureau: Bureau;
  value: string;
}

/**
 * Surface every per-bureau personal info value as a candidate the student can
 * flag for dispute. The student chooses which to actually dispute and what
 * reason to attach.
 */
export function listPersonalInfo(report: CreditReport): PersonalInfoCandidate[] {
  const out: PersonalInfoCandidate[] = [];
  const pi = report.personalInfo;
  const bureaus: Bureau[] = ["experian", "equifax", "transunion"];

  for (const bureau of bureaus) {
    const addr = pi.currentAddress?.[bureau];
    if (addr) {
      out.push({ id: `pi-addr-${bureau}`, field: "currentAddress", bureau, value: addr });
    }
    const prev = pi.previousAddresses?.[bureau] ?? [];
    prev.forEach((p, i) => {
      out.push({ id: `pi-prev-${bureau}-${i}`, field: "previousAddress", bureau, value: p });
    });
    const name = pi.name?.[bureau];
    if (name) out.push({ id: `pi-name-${bureau}`, field: "name", bureau, value: name });
    const emp = pi.employer?.[bureau];
    if (emp) out.push({ id: `pi-emp-${bureau}`, field: "employer", bureau, value: emp });
    const phone = pi.phone?.[bureau];
    if (phone) out.push({ id: `pi-phone-${bureau}`, field: "phone", bureau, value: phone });
  }

  return out;
}
