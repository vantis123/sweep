/**
 * Shared parser helpers.
 * These handle the "concatenated 3-bureau values" pattern common to both IIQ
 * and FSN web reports — fields like "REVOLVINGREVOLVINGREVOLVING" or
 * "$1,502.00$1,001.00$1,001.00" need to be split into 3 per-bureau values.
 */

import type { AccountCategory, Bureau, BureauAccountDetail } from "./types.ts";

/** Split a numeric string of length 3*n into 3 equal chunks of length n. */
export function split3Equal(s: string | null | undefined, partLen: number): [string, string, string] | null {
  if (!s || s.length !== partLen * 3) return null;
  return [s.slice(0, partLen), s.slice(partLen, partLen * 2), s.slice(partLen * 2)];
}

/** Try to auto-detect equal split: if length divisible by 3, split equally. Returns null if not. */
export function splitEqualOrNull(s: string): [string, string, string] | null {
  if (!s) return null;
  if (s.length % 3 !== 0) return null;
  const len = s.length / 3;
  return [s.slice(0, len), s.slice(len, len * 2), s.slice(len * 2)];
}

/** Parse a "$1,502.00$1,001.00$1,001.00" string into [tu, ex, eq] dollar values. */
export function splitDollars3(s: string | null | undefined): [number | null, number | null, number | null] {
  if (!s) return [null, null, null];
  const parts = s.split("$").filter(Boolean);
  if (parts.length !== 3) return [null, null, null];
  return parts.map((p) => {
    const cleaned = p.replace(/,/g, "").trim();
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }) as [number | null, number | null, number | null];
}

/** Parse a single dollar string (with or without $, with or without commas) to a number. */
export function parseDollar(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[$,\s]/g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned === "--") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Convert a "6y 7m" / "6y" / "85m" age string to total months. */
export function parseAgeMonths(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(?:(\d+)\s*y(?:ears?)?)?\s*(?:(\d+)\s*m(?:onths?)?)?/i);
  if (!m) return null;
  const years = m[1] ? parseInt(m[1], 10) : 0;
  const months = m[2] ? parseInt(m[2], 10) : 0;
  if (years === 0 && months === 0) return null;
  return years * 12 + months;
}

/** Lowercase keyword check for categorizing an account by status text. */
export function categorizeFromStatus(status: string | undefined): AccountCategory {
  if (!status) return "unknown";
  const s = status.toLowerCase();
  if (/charge.?off/i.test(s)) return "chargeoff";
  if (/collection/i.test(s)) return "collection";
  if (/foreclosure/i.test(s)) return "foreclosure";
  if (/repossess/i.test(s)) return "repossession";
  if (/bankrupt/i.test(s)) return "bankruptcy";
  if (/late\s*150|150\s*days/i.test(s)) return "late150";
  if (/late\s*120|120\s*days/i.test(s)) return "late120";
  if (/late\s*90|90\s*days/i.test(s)) return "late90";
  if (/late\s*60|60\s*days/i.test(s)) return "late60";
  if (/late\s*30|30\s*days/i.test(s)) return "late30";
  if (/settled/i.test(s)) return "settled";
  if (/transferred/i.test(s)) return "transferred";
  if (s === "current" || /^current$/i.test(s)) return "current";
  if (/closed/i.test(s)) return "closed";
  return "unknown";
}

/** Roll up a per-bureau category map to a single account-level category (worst-case wins). */
export function rollupCategory(perBureau: Partial<Record<Bureau, AccountCategory>>): AccountCategory {
  const SEVERITY: AccountCategory[] = [
    "chargeoff",
    "collection",
    "foreclosure",
    "repossession",
    "bankruptcy",
    "late150",
    "late120",
    "late90",
    "late60",
    "late30",
    "settled",
    "transferred",
    "closed",
    "current",
    "unknown",
  ];
  for (const cat of SEVERITY) {
    if (Object.values(perBureau).includes(cat)) return cat;
  }
  return "unknown";
}

/** True if the rolled-up category represents a negative item Bank should flag. */
export function isNegativeCategory(cat: AccountCategory): boolean {
  return [
    "chargeoff",
    "collection",
    "foreclosure",
    "repossession",
    "bankruptcy",
    "late30",
    "late60",
    "late90",
    "late120",
    "late150",
  ].includes(cat);
}

/** Given a per-bureau detail object, infer its category from any signal we have. */
export function categorizeBureau(detail: BureauAccountDetail): AccountCategory {
  // Try paymentStatus first — most explicit
  if (detail.paymentStatus) {
    const cat = categorizeFromStatus(detail.paymentStatus);
    if (cat !== "unknown") return cat;
  }
  if (detail.accountStatus) {
    const cat = categorizeFromStatus(detail.accountStatus);
    if (cat !== "unknown") return cat;
  }
  // Charge-off amount > 0 = chargeoff
  if ((detail.chargeOffAmount ?? 0) > 0) return "chargeoff";
  // Past due > 0 with no other signal = late, severity unknown
  if ((detail.pastDue ?? 0) > 0) return "late30";
  // Comments scan (FSN-style fallback)
  if (detail.comments) {
    const cat = categorizeFromStatus(detail.comments);
    if (cat !== "unknown") return cat;
  }
  if (detail.accountCondition?.toUpperCase() === "CLOSED") return "closed";
  if (detail.accountCondition?.toUpperCase() === "OPEN") return "current";
  return "unknown";
}
