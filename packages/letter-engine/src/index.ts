/**
 * @sweep/letter-engine — turns a CreditReport + the student's review choices
 * into per-bureau Affidavit of Truth letter inputs ready to render.
 *
 * Flow:
 *   1. listDisputables(report) → every negative item + inquiry + public record
 *   2. UI lets the student uncheck items, pick a reason per item, set personal info
 *   3. buildAffidavitInputs({ report, selections, client }) → 3 AffidavitInputs
 *   4. renderAffidavitHtml(input) → HTML the pdf-renderer turns into a PDF page
 */

import type { Bureau, CreditReport } from "@sweep/parsers";
import { BUREAU_CONTACTS, BUREAU_ORDER } from "./bureaus.ts";
import { reasonById } from "./reasons.ts";
import type { AffidavitInput, AffidavitItem, AffidavitPersonalInfoItem } from "./render-affidavit.ts";

export interface ItemSelection {
  id: string;
  bureau: Bureau;
  creditor: string;
  detail: string;
  reasonId: string;
  customReasonText?: string;
}

export interface PersonalInfoSelection {
  id: string;
  bureau: Bureau;
  fieldLabel: string;
  value: string;
  reasonId: string;
  customReasonText?: string;
}

export interface ClientInfo {
  fullName: string;
  address: string;
  cityStateZip: string;
  dob: string;
  ssnLast4: string;
}

export interface BuildLettersInput {
  report: CreditReport;
  client: ClientInfo;
  itemSelections: ItemSelection[];
  personalInfoSelections: PersonalInfoSelection[];
  letterDate?: string;
}

export interface PerBureauLetter {
  bureau: Bureau;
  input: AffidavitInput;
}

function resolveReason(reasonId: string, customText?: string): string {
  if (customText && customText.trim().length > 0) return customText.trim();
  const r = reasonById(reasonId);
  return r ? r.text : "This item is inaccurate and must be reinvestigated under FCRA §611.";
}

function formatToday(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function buildAffidavitInputs(input: BuildLettersInput): PerBureauLetter[] {
  const date = input.letterDate?.trim() || formatToday();
  const out: PerBureauLetter[] = [];

  for (const bureau of BUREAU_ORDER) {
    const items: AffidavitItem[] = input.itemSelections
      .filter((s) => s.bureau === bureau)
      .map((s) => ({
        creditor: s.creditor,
        detail: s.detail,
        reasonText: resolveReason(s.reasonId, s.customReasonText),
      }));

    const personalInfoItems: AffidavitPersonalInfoItem[] = input.personalInfoSelections
      .filter((s) => s.bureau === bureau)
      .map((s) => ({
        fieldLabel: s.fieldLabel,
        value: s.value,
        reasonText: resolveReason(s.reasonId, s.customReasonText),
      }));

    if (items.length === 0 && personalInfoItems.length === 0) continue;

    out.push({
      bureau,
      input: {
        client: input.client,
        bureau: BUREAU_CONTACTS[bureau],
        date,
        items,
        personalInfoItems,
      },
    });
  }

  return out;
}

export { BUREAU_CONTACTS, BUREAU_ORDER } from "./bureaus.ts";
export { ACCOUNT_DISPUTE_REASONS, PERSONAL_INFO_DISPUTE_REASONS, reasonById } from "./reasons.ts";
export type { DisputeReason } from "./reasons.ts";
export { listDisputables, listPersonalInfo } from "./identify-negatives.ts";
export type { DisputableItem, PersonalInfoCandidate } from "./identify-negatives.ts";
export { renderAffidavitHtml } from "./render-affidavit.ts";
export type {
  AffidavitInput,
  AffidavitItem,
  AffidavitPersonalInfoItem,
  AffidavitClient,
} from "./render-affidavit.ts";
