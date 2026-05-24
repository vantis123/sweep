<div align="center">

# Sweep

**The three-bureau dispute letter engine for credit pros.**

Pulls a client's credit report from MyFreeScoreNow or IdentityIQ. Auto-flags every negative item. Generates three Affidavit of Truth letters — one per bureau, every negative item bundled, FCRA §605B statute and breach screenshot enclosed — ready to print and mail certified.

</div>

---

## Why Sweep exists

Round 1 disputes shouldn't take an afternoon per client. Sweep does the entire setup in one click:

- Logs in. Pulls. Parses.
- Groups every negative by bureau.
- Three PDFs out. Print. Mail. Done.

Built for Skool members running KMK-style credit repair playbooks on their own clients.

---

## Quick start

```bash
git clone https://github.com/vantis123/sweep.git
cd sweep
npm install
npm start
```

Browser auto-opens to `http://localhost:7879`. That's it. (Bank uses `:7878` — Sweep sits next to it on `:7879` so you can run both at the same time.)

> **Mac shortcut:** double-click `Run Sweep.command` after unzipping. It handles `npm install` + `npm start` for you.
>
> **Windows shortcut:** double-click `Run Sweep.bat` after unzipping. Same one-click experience, runs through cmd so PowerShell's execution policy never gets in the way.

> **Don't have Node.js yet?** Grab the LTS version from [nodejs.org](https://nodejs.org/en/download) first (5 minutes, one-time setup).

See [INSTALL.md](INSTALL.md) for the step-by-step walkthrough if you've never used a terminal.

---

## The flow

1. Open Sweep — browser opens to the local dashboard.
2. Enter your client's MyFreeScoreNow or IdentityIQ login.
3. Hit **Pull report**. Sweep logs in in a real browser, captures the report, parses it.
4. Review the negative items table. Every charge-off, collection, late, hard inquiry, and public record is auto-flagged. Uncheck anything you don't want to dispute.
5. Pick a dispute reason for each item from the dropdown (or write your own).
6. Verify the client's personal info (auto-filled from the report — edit anything wrong).
7. Hit **Generate letters**. Three PDFs drop into `letters/{client-name}/`.
8. Print, sign, mail certified to each bureau. Mail your client's FTC identitytheft.gov report alongside.

---

## What goes in each letter

Each of the three PDFs contains, in order:

1. **Affidavit of Truth** — addressed to the bureau, lists every disputed item with the reason you picked, signed by the client.
2. **FCRA §605B statute** — the law that requires the bureau to block fraudulent items within 4 business days.
3. **Breach screenshot** — your enclosure proving the data breach that exposed the client's information.

---

## Bureau mailing addresses (printed on each letter)

| Bureau | Address |
|---|---|
| Experian | PO Box 4500, Allen, TX 75013 |
| Equifax | PO Box 740256, Atlanta, GA 30374 |
| TransUnion | PO Box 2000, Chester, PA 19016 |

All three accept consumer disputes by mail. Send certified with return receipt. Keep the green card.

---

## Two doors. Same engine.

Sweep can be used two ways — pick the one that fits how you work.

### Door 1 — Dashboard (no AI required)

The default. Local webpage at `http://localhost:7879`. Type creds, click Pull, review items, click Generate. What you've been using.

### Door 2 — MCP server (for Claude Code, Cursor, etc.)

For students who use AI assistants, Sweep exposes 3 tools any MCP-compatible client can call:

| Tool | What it does |
|---|---|
| `sweep_pull_iiq_report` | Login → click "View Latest Report" → click "Download this report" → save HTML |
| `sweep_extract_accounts` | HTML → every account with per-bureau data + auto-detected negatives |
| `sweep_generate_letters` | Client info + per-bureau dispute selections → 3 PDF letters |

Add this to your `~/.claude/mcp.json` (or your client's equivalent):

```json
{
  "mcpServers": {
    "sweep": {
      "command": "node",
      "args": ["/absolute/path/to/sweep/apps/mcp-server/src/index.ts"]
    }
  }
}
```

Restart your AI client. Then prompt:

> *"Pull John Smith's IIQ credit report (creds: john@email.com / hunter2 / 4271) and generate the 3 dispute letters."*

Claude calls Sweep's tools, applies the same dispute-selection rules baked into the server's instructions (only closed negatives, no inquiries, per-bureau status independence, IIQ's naming preserved), and writes 3 PDFs to `letters/{client-slug}/`. Uses YOUR Claude subscription — Sweep charges nothing per pull.

The agent flow shines when IIQ's HTML has edge cases the coded path can't handle alone — Claude reads each listing in context and makes judgment calls.

---

## Sister product

[Bank](https://github.com/vantis123/bank) grades the report for funding eligibility. Sweep generates the dispute letters that clean it up. Same toolkit. Same one-click install.

---

Built by [Arvantis Tech](https://arvantis.tech). Local-first. No SaaS account required. No telemetry.
