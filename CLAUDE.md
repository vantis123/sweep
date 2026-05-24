# Sweep — Project Operating Rules (for Claude)

Sister product to Bank. Standalone product repo, separate from the Arvantis Tech main repo. Built for distribution to credit pros via Phillip's Skool mentorship community.

## What Sweep is

A local-first tool that:
1. Logs into a client's credit monitoring portal (FSN + IIQ in v1)
2. Pulls the full credit report
3. Parses it into structured JSON (scores, summary, accounts, inquiries, public records, personal info)
4. Auto-flags negative items (charge-offs, collections, late pays, hard inquiries, public records)
5. Lets the student review/uncheck items and add personal-info disputes
6. Generates three Affidavit of Truth dispute letters — one per bureau (Experian, Equifax, TransUnion) — each bundled with the FCRA §605B statute and a breach screenshot
7. Drops the three PDFs to disk, ready for the student to print and mail certified

## What Sweep is NOT

- Not cloud-hosted — runs entirely on the student's machine
- Not LLM-dependent — no API keys needed
- Not a CRM — each session is one client, no DB
- Not multi-round — v1 ships Round 1 letters only (Affidavit of Truth / 605B posture)
- Not licensed/DRM'd — gated only by Skool membership

## Architecture

- npm workspaces monorepo (universal Node, no Bun/pnpm required)
- TypeScript throughout, ESM modules
- Express + vanilla HTML/JS for the dashboard (no React build step — keep it simple)
- Playwright headed by default for capture + headless for PDF rendering
- Handlebars for the affidavit template
- pdf-lib for merging the affidavit PDF with the static 605B PDF and breach screenshot

## Code conventions

- TypeScript everywhere, ESM imports only
- No telemetry, no analytics, no phone-home
- No external dependencies that require API keys
- Vendored from Bank: `packages/parsers` and `packages/playwright-flows` (renamed `@bank/` → `@sweep/`). These are kept in sync manually when Bank upgrades — diff and port over.

## Letter posture

The Affidavit of Truth template takes a §605B identity-theft posture. Phillip teaches students to file an FTC identitytheft.gov report alongside mailing these letters, so the "Identity Theft Report attached" claim in the affidavit is honest. Do NOT soften the language without explicit direction.

## Phillip's communication style

- Casual, fast, action-oriented
- Hates over-explanation and walls of text
- Hates unsolicited additions (deliver what was asked, stop)
- Hates dashes in copy (use periods or commas) — applies to letter copy too
- Wants the dumb-simple fix first, not the engineering rewrite
- Speaks via voice-to-text often — interpret loose punctuation generously

## Hard rules from prior conversations

- No backwards-compatibility shims, no half-finished implementations
- No comments unless the WHY is non-obvious
- No documentation files unless explicitly requested
- Investigate WITH Phillip before editing — don't rapid-fire guess-edits during debug
- Verify each fix takes effect before layering more
