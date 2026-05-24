# Sweep MCP Server

Sweep ships with an MCP server (`@sweep/mcp-server`) that exposes the same
capture + parse + letter-generation pipeline as the dashboard, but as agent
tools you can call from Claude Code, Cursor, or any other MCP client.

## Tools

| Tool | What it does |
|---|---|
| `sweep_pull_iiq_report` | Logs into IIQ in a headed browser, navigates to `/CreditReport.aspx`, clicks "Print this page", renders the page as a vector PDF. Returns the PDF path. |
| `sweep_extract_accounts` | Reads the rendered PDF, returns every account with per-bureau fields + payment-history late marks. Pre-computed dispute targets per bureau (after applying chargeoff/collection/late/derogatory/cross-bureau-propagation rules + deferment skip). |
| `sweep_generate_letters` | Takes client personal info + per-bureau dispute selections, writes 3 PDF dispute letters into `letters/<client-slug>/`. Also drops the breach screenshot and a copy of the credit-report PDF into the same folder. |

## Quick start (Claude Code)

Add an entry to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "sweep": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/sweep/apps/mcp-server/src/index.ts"]
    }
  }
}
```

Replace `/absolute/path/to/sweep` with where you cloned the repo.

Restart Claude Code. The three tools above will show up under the `sweep`
namespace. Just ask the agent to pull a credit report and generate dispute
letters — it knows the workflow from the server's instructions block.

## Local sanity test

```bash
cd sweep
npm install
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' | npx tsx apps/mcp-server/src/index.ts
```

Should print a JSON-RPC response listing Sweep's `tools` capability + the
agent instructions. If it does, the MCP is wired correctly.

## What gets written where

- **Captured report (PDF):** `~/.sweep/sandbox/iiq-credit-report-<timestamp>.pdf`
- **Per-client folder:** `letters/<client-slug>/`
  - `sweep-<client>-transunion-<timestamp>.pdf`
  - `sweep-<client>-experian-<timestamp>.pdf`
  - `sweep-<client>-equifax-<timestamp>.pdf`
  - `breach-screenshot.png`
  - `credit-report.pdf`

Everything is local. Nothing phones home.

## Sister product

Sweep sits next to **Bank** (Phillip's funding intelligence tool). Same
monorepo style, same auth + capture stack, different output. If Bank is
running on `localhost:7878`, Sweep runs on `localhost:7879` so you can use
both at once without conflict.
