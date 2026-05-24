/**
 * Sweep — full pipeline runner (CLI, no UI).
 *
 * Runs login → capture → parse → flag → render → 3 PDFs end-to-end with verbose
 * step-by-step logs so we can see exactly what each layer produces. Use this
 * to debug the pipeline before exposing it through the dashboard.
 *
 *   PLATFORM=iiq USERNAME=client@email.com PASSWORD=hunter2 LAST4=4271 \
 *     CLIENT="John Smith" npx tsx apps/dashboard/test/run-pipeline.ts
 *
 *   PLATFORM=fsn USERNAME=... PASSWORD=... CLIENT="Jane Doe" \
 *     npx tsx apps/dashboard/test/run-pipeline.ts
 *
 * Output:
 *   ~/.sweep/sandbox/                          screenshots + capture artifacts
 *   /tmp/sweep-run-{timestamp}-capture.txt     the raw captured text
 *   /tmp/sweep-run-{timestamp}-report.json     the parsed CreditReport
 *   letters/{client-slug}/                     3 generated dispute PDFs
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { parseFSNAny, parseIIQ } from "@sweep/parsers";
import { captureFSN, captureIIQ } from "@sweep/playwright-flows";
import {
  ACCOUNT_DISPUTE_REASONS,
  PERSONAL_INFO_DISPUTE_REASONS,
  buildAffidavitInputs,
  listDisputables,
  listPersonalInfo,
  renderAffidavitHtml,
  type ItemSelection,
  type PersonalInfoSelection,
} from "@sweep/letter-engine";
import { renderLetterPdf } from "@sweep/pdf-renderer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "packages", "letter-engine", "templates");
const FCRA_605B_PATH = resolve(TEMPLATES_DIR, "fcra-605b.pdf");
const BREACH_IMAGE_PATH = resolve(TEMPLATES_DIR, "breach-screenshot.png");
const LETTERS_DIR = resolve(REPO_ROOT, "letters");
const SANDBOX_DIR = resolve(homedir(), ".sweep", "sandbox");

function step(num: number, label: string) {
  console.log(`\n  ── ${num.toString().padStart(2, "0")}  ${label}`);
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "client"
  );
}

function detectNoActiveReport(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("subscription has expired") || lower.includes("renew your subscription"))
    return "Subscription expired.";
  if (lower.includes("we were unable to verify") || lower.includes("identity verification"))
    return "Identity verification step in the way.";
  const hits =
    Number(lower.includes("equifax")) +
    Number(lower.includes("experian")) +
    Number(lower.includes("transunion"));
  if (hits < 3) return `Only ${hits} of 3 bureau names found — not a 3-bureau report.`;
  return null;
}

async function main() {
  const platform = (process.env.PLATFORM || "iiq").toLowerCase() as "fsn" | "iiq";
  const username = process.env.SWEEP_USERNAME;
  const password = process.env.SWEEP_PASSWORD;
  const last4 = process.env.LAST4;
  const clientName = process.env.CLIENT || "Test Client";
  const headed = process.env.HEADED !== "0";

  if (!username || !password) {
    console.error("\n  ✗ Missing SWEEP_USERNAME or SWEEP_PASSWORD env vars.\n");
    console.error("  Usage:");
    console.error('    PLATFORM=iiq SWEEP_USERNAME=... SWEEP_PASSWORD=... LAST4=... CLIENT="Name" npx tsx apps/dashboard/test/run-pipeline.ts\n');
    process.exit(1);
  }
  if (platform === "iiq" && !last4) {
    console.warn("\n  ⚠ IIQ pulls usually need LAST4 for the security challenge — continuing anyway.\n");
  }

  await mkdir(SANDBOX_DIR, { recursive: true });

  const timestamp = Date.now();
  const captureTextPath = resolve("/tmp", `sweep-run-${timestamp}-capture.txt`);
  const reportJsonPath = resolve("/tmp", `sweep-run-${timestamp}-report.json`);
  const clientSlug = slug(clientName);
  const outDir = resolve(LETTERS_DIR, clientSlug);

  console.log(`\n  Sweep pipeline runner`);
  console.log(`  platform:   ${platform}`);
  console.log(`  username:   ${username}`);
  console.log(`  last4:      ${last4 ? `${last4.slice(0, 2)}**` : "(none)"}`);
  console.log(`  client:     ${clientName} (${clientSlug})`);
  console.log(`  headed:     ${headed}`);
  console.log(`  sandbox:    ${SANDBOX_DIR}`);
  console.log(`  letters:    ${outDir}`);

  step(1, "Capture (Playwright login + report pull)");
  const captureFn = platform === "fsn" ? captureFSN : captureIIQ;
  const t0 = Date.now();
  const cap = await captureFn({
    username,
    password,
    last4,
    headed,
    sandboxDir: SANDBOX_DIR,
    onLog: (msg) => console.log(`     ${msg}`),
  });
  console.log(`     done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ok=${cap.ok} · text=${cap.text.length} chars · screenshots=${cap.screenshots.length}`);
  if (cap.screenshots.length > 0) {
    cap.screenshots.forEach((s) => console.log(`        screenshot → ${s}`));
  }
  if (cap.warnings.length > 0) {
    cap.warnings.forEach((w) => console.log(`        warning → ${w}`));
  }
  if (!cap.ok || cap.text.length === 0) {
    console.error(`\n  ✗ Capture failed: ${cap.error ?? "no text returned"}\n`);
    process.exit(1);
  }
  await writeFile(captureTextPath, cap.text, "utf8");
  console.log(`     raw capture saved → ${captureTextPath}`);

  step(2, "Sanity check (no-active-report detection)");
  const noReport = detectNoActiveReport(cap.text);
  if (noReport) {
    console.error(`     ✗ ${noReport}`);
    console.error(`\n  Stopping here — there is no parseable credit report on the captured page.`);
    console.error(`  Inspect:  ${captureTextPath}`);
    console.error(`  Screenshots: ${SANDBOX_DIR}\n`);
    process.exit(2);
  }
  console.log(`     ✓ Looks like a real report — proceeding to parse`);

  step(3, "Parse");
  const report = platform === "iiq" ? parseIIQ(cap.text) : parseFSNAny(cap.text);
  console.log(`     scores:       equifax=${report.scores.equifax} · experian=${report.scores.experian} · transunion=${report.scores.transunion}`);
  console.log(`     accounts:     ${report.accounts.length}`);
  console.log(`     inquiries:    ${report.inquiries.length}`);
  console.log(`     publicRec:    ${report.publicRecords.length}`);
  console.log(`     warnings:     ${report.warnings.length}`);
  console.log(`     errors:       ${report.errors.length}`);
  if (report.warnings.length) report.warnings.forEach((w) => console.log(`        warn → ${w}`));
  if (report.errors.length) report.errors.forEach((e) => console.log(`        err  → ${e}`));
  console.log(`     account categories:`, report.accounts.slice(0, 10).map((a) => `${a.creditor}:${a.category}${a.isNegative ? "*" : ""}`).join(", "));
  await writeFile(reportJsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`     parsed report saved → ${reportJsonPath}`);

  step(4, "Flag (listDisputables + listPersonalInfo)");
  const disputables = listDisputables(report);
  const piCandidates = listPersonalInfo(report);
  const byBureau: Record<string, number> = {};
  for (const d of disputables) byBureau[d.bureau] = (byBureau[d.bureau] ?? 0) + 1;
  console.log(`     disputables:  ${disputables.length}  ·  per bureau:`, byBureau);
  console.log(`     personalInfo: ${piCandidates.length}`);
  disputables.slice(0, 8).forEach((d) => console.log(`        ${d.bureau.padEnd(11)} ${d.kind.padEnd(14)} ${d.creditor} — ${d.detail}`));
  if (disputables.length === 0 && piCandidates.length === 0) {
    console.error(`\n  ✗ Parser returned a report but nothing was flagged for dispute.`);
    console.error(`  Inspect:  ${reportJsonPath}\n`);
    process.exit(3);
  }

  step(5, "Build affidavit inputs (group by bureau)");
  // Round-robin reasons for the sake of seeing template variety in this run.
  const itemSelections: ItemSelection[] = disputables.map((d, i) => ({
    id: d.id,
    bureau: d.bureau,
    creditor: d.creditor,
    detail: d.detail,
    reasonId: ACCOUNT_DISPUTE_REASONS[i % ACCOUNT_DISPUTE_REASONS.length].id,
  }));
  const piSelections: PersonalInfoSelection[] = piCandidates
    .filter((c) => c.field === "currentAddress" || c.field === "previousAddress")
    .map((c, i) => ({
      id: c.id,
      bureau: c.bureau,
      fieldLabel: c.field === "currentAddress" ? "Current address" : "Previous address",
      value: c.value,
      reasonId: PERSONAL_INFO_DISPUTE_REASONS[i % PERSONAL_INFO_DISPUTE_REASONS.length].id,
    }));

  const piName = report.personalInfo.name;
  const firstName =
    (piName?.experian ?? piName?.equifax ?? piName?.transunion ?? clientName);
  const piAddr = report.personalInfo.currentAddress;
  const firstAddr = (piAddr?.experian ?? piAddr?.equifax ?? piAddr?.transunion ?? "").trim();
  let address = firstAddr;
  let cityStateZip = "";
  const lastComma = firstAddr.lastIndexOf(",");
  if (lastComma > -1) {
    const secondLast = firstAddr.lastIndexOf(",", lastComma - 1);
    if (secondLast > -1) {
      address = firstAddr.slice(0, secondLast).trim();
      cityStateZip = firstAddr.slice(secondLast + 1).trim();
    } else {
      address = firstAddr.slice(0, lastComma).trim();
      cityStateZip = firstAddr.slice(lastComma + 1).trim();
    }
  }
  const ssn4 = report.personalInfo.ssnLast4;
  const ssnLast4 = ssn4?.experian ?? ssn4?.equifax ?? ssn4?.transunion ?? "";
  const birthYear =
    report.personalInfo.birthYear?.experian ??
    report.personalInfo.birthYear?.equifax ??
    report.personalInfo.birthYear?.transunion ??
    "";

  const client = {
    fullName: firstName,
    address,
    cityStateZip,
    dob: birthYear ? `01/01/${birthYear}` : "",
    ssnLast4,
  };
  console.log(`     client info auto-derived from report:`);
  console.log(`        fullName:      ${client.fullName}`);
  console.log(`        address:       ${client.address}`);
  console.log(`        cityStateZip:  ${client.cityStateZip}`);
  console.log(`        dob:           ${client.dob}`);
  console.log(`        ssnLast4:      ${client.ssnLast4}`);

  const perBureau = buildAffidavitInputs({
    report,
    client,
    itemSelections,
    personalInfoSelections: piSelections,
  });
  console.log(`     letters built: ${perBureau.length}  ·  bureaus:`, perBureau.map((p) => p.bureau).join(", "));

  step(6, "Render PDFs");
  await mkdir(outDir, { recursive: true });
  for (const { bureau, input } of perBureau) {
    const html = await renderAffidavitHtml(input);
    const outPath = resolve(outDir, `sweep-${clientSlug}-${bureau}-${timestamp}.pdf`);
    await renderLetterPdf({
      html,
      fcra605bPath: FCRA_605B_PATH,
      breachImagePath: existsSync(BREACH_IMAGE_PATH) ? BREACH_IMAGE_PATH : undefined,
      outputPath: outPath,
    });
    const stats = await import("node:fs").then((m) => m.statSync(outPath));
    console.log(`     ✓ ${bureau.padEnd(11)} ${(stats.size / 1024).toFixed(1)} KB → ${outPath}`);
  }

  console.log(`\n  ✓ Pipeline complete. ${perBureau.length} letters written to ${outDir}\n`);
}

main().catch((err) => {
  console.error(`\n  ✗ Pipeline error: ${err.message}\n`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
