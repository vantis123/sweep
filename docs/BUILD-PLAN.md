# Sweep — Build Plan

Phases from scaffold to Skool launch. Sister product to Bank, sharing the
same auth + capture stack but with dispute-letter output instead of a
funding intel PDF.

## Phase 0 — Scaffold ✅

- [x] npm workspaces monorepo at `/Users/Krownz/sweep/`
- [x] Apps: `dashboard`, `mcp-server`
- [x] Packages: `parsers`, `playwright-flows`, `letter-engine`, `pdf-renderer`
- [x] Root README + CLAUDE.md + .gitignore + INSTALL.md
- [x] Git init + initial commit

## Phase 1 — Parsers ✅

Vendored from Bank's `@bank/parsers`. Renamed `@bank/` → `@sweep/`. Added:

- `parseFSN3B` — MFSN 3B Classic View HTML parser (cheerio + CSS Grid)
- `parseIIQPdf` — IIQ rendered-PDF parser (pdfjs-dist + positional text)
- `listIIQPdfDisputes` — per-bureau dispute selection with cross-bureau
  propagation, payment-history scan, deferment skip

## Phase 2 — Playwright flows ✅

Vendored from Bank's `@bank/playwright-flows`. Updated:

- IIQ: removed "Download this report" path, now navigates to
  `/CreditReport.aspx`, clicks "Print this page", renders PDF via
  `page.pdf()`. PDF is the canonical capture format.
- FSN: added Reports dropdown nav, Quick Tour modal dismissal,
  Switch to Classic View toggle.
- Both: bot-detection bypass via `--disable-blink-features=AutomationControlled`
  + `addInitScript` overriding navigator.webdriver/languages/plugins.

## Phase 3 — Letter engine ✅

- Handlebars affidavit template (Affidavit of Truth + §605B posture)
- Single shared reason block (plural language) instead of per-item reasons
- 10 account-dispute reason presets + 5 personal-info presets
- `buildAffidavitInputs` produces per-bureau letter inputs from selections

## Phase 4 — PDF renderer ✅

- `renderAffidavitHtml` (Handlebars) + `renderLetterPdf` (pdf-lib)
- Merges: affidavit page + FCRA §605B statute PDF + breach screenshot

## Phase 5 — Dashboard ✅

Express server on `localhost:7879`:
- `/api/pull` — captures + parses, returns disputables for review
- `/api/generate` — takes selections, writes 3 PDFs + breach.png +
  credit-report.pdf to `letters/<client-slug>/`
- Vanilla HTML/JS frontend with review table, dispute reason picker,
  personal info section

## Phase 6 — MCP server ✅

Three tools exposed via `@modelcontextprotocol/sdk`:
- `sweep_pull_iiq_report`
- `sweep_extract_accounts`
- `sweep_generate_letters`

See [MCP.md](../MCP.md) for wiring instructions.

## Phase 7 — Skool distribution (next)

- [x] One-click launchers: `Run Sweep.command` (Mac) + `Run Sweep.bat` (Windows)
- [ ] Polish landing page / shipping checklist
- [ ] Record demo video for Skool community
- [ ] Versioned release on GitHub (tag v0.1.0)

## Validation results (current)

Tested against internal manual deletion reports across the four canonical
account shapes:

- **Open + currently late** (e.g., credit card 30/60/90 days late)
- **Closed with historical lates** (paid-off card that was late in the past)
- **Collections** (single-bureau and multi-bureau)
- **Charge-offs** (current and historical)

**MFSN** — 3/3 test clients 100% match against manual review.

**IIQ** — 2/4 test clients 100% match. Other 2 had minor over-counts on
Equifax from the catch-all cross-bureau propagation rule (any negative →
propagate to all bureaus where the account is reporting). Manual review
is more selective per account. Cross-bureau propagation is tunable to
"strict" (bureau-specific only) if needed.
