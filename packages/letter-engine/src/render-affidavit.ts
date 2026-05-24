import Handlebars from "handlebars";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { Bureau } from "@sweep/parsers";
import type { BureauContact } from "./bureaus.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "..", "templates", "affidavit-of-truth.hbs");

let cachedTemplate: HandlebarsTemplateDelegate | null = null;

async function loadTemplate(): Promise<HandlebarsTemplateDelegate> {
  if (cachedTemplate) return cachedTemplate;
  const src = await readFile(TEMPLATE_PATH, "utf8");
  cachedTemplate = Handlebars.compile(src);
  return cachedTemplate;
}

export interface AffidavitClient {
  fullName: string;
  address: string;
  cityStateZip: string;
  dob: string;
  ssnLast4: string;
}

export interface AffidavitItem {
  creditor: string;
  detail: string;
  /** Retained for back-compat. Not rendered per-item anymore; the shared
   *  reason on the parent AffidavitInput is what gets shown to the bureau. */
  reasonText?: string;
}

export interface AffidavitPersonalInfoItem {
  fieldLabel: string;
  value: string;
  reasonText: string;
}

export interface AffidavitInput {
  client: AffidavitClient;
  bureau: BureauContact;
  date: string;
  items: AffidavitItem[];
  personalInfoItems: AffidavitPersonalInfoItem[];
  /** One reason that applies to every account in `items`. If omitted, we
   *  fall back to the first item's `reasonText` for back-compat. */
  sharedReason?: string;
}

export async function renderAffidavitHtml(input: AffidavitInput): Promise<string> {
  const tpl = await loadTemplate();
  const sharedReason =
    input.sharedReason ??
    input.items.find((i) => i.reasonText)?.reasonText ??
    "";
  return tpl({ ...input, sharedReason });
}

export type { Bureau };
