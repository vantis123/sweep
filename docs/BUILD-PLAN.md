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

Tested against Phillip's manual deletion reports (Google Drive):

**MFSN** — 3/3 clients 100% match:
- Shaun Bailer: TU=5 EX=3 EQ=1 ✓
- Desire Ruiz: TU=0 EX=0 EQ=4 ✓
- Brandon Coleman: TU=4 EX=3 EQ=1 ✓

**IIQ** — 2/4 clients 100% match:
- DShaad Bannister: TU=2 EX=1 EQ=1 ✓
- Jashard Nelson: TU=2 EX=4 EQ=3 ✓ (FAIRWAY VILLAGE correctly EQ via
  pdfjs-dist positional parsing)
- Trevor Tolley: +1 EQ over Drive (cross-bureau propagation)
- Scadia Fuller: +2 EQ over Drive (cross-bureau propagation)

The +1/+2 over Drive comes from the catch-all cross-bureau propagation
rule (any negative → propagate to all bureaus where account exists).
Drive's manual review is more selective. Tunable if needed.
