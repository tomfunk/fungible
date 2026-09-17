# Integrations

fungible exposes the same set of tools two ways: as an MCP server (for Claude Desktop and other MCP clients) and as a REST API (for scripting and automation).

## HTTP API

Starts automatically on port 3456 when you run the TUI. To run standalone:

```bash
fungible api
# or: npm run api
# Listening on http://localhost:3456
```

The GUI does **not** start the API server in the background — run it separately if you want both surfaces live.

**Endpoint:** `POST /tools/:name` with a JSON body.

```bash
curl -X POST http://localhost:3456/tools/spending_summary \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"year": 2026, "month": 5}'
```

**Configuration** (in `~/.fungible/.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `FUNGIBLE_API_KEY` | _(none)_ | Bearer token required on all requests. If unset, auth is skipped (dev only). |
| `FUNGIBLE_API_PORT` | `3456` | Port to listen on. |

Available tools: same set as the MCP server below.

## MCP Server

Exposes your financial data to Claude via the [Model Context Protocol](https://modelcontextprotocol.io).

**Two connection modes:**

- **stdio** — Claude Desktop spawns `fungible mcp` as a child process. Always works, even when the TUI isn't open. When the TUI is running, writes notify it automatically so the UI refreshes. Use this if you're not sure which to pick.

- **HTTP** — when the TUI is running, it starts an HTTP MCP server on port 3741 (`FUNGIBLE_MCP_PORT` to override). Point Claude at `http://localhost:3741/mcp` instead of using a command — writes are in-process so the TUI updates instantly. Only works while the TUI is open. The GUI does not start this; use stdio with the GUI.

Config file location:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux / WSL:** `~/.config/Claude/claude_desktop_config.json`

**stdio — Homebrew (macOS):**
```json
{
  "mcpServers": {
    "fungible": {
      "command": "/opt/homebrew/bin/node",
      "args": ["--no-warnings", "--import", "tsx/esm", "/opt/homebrew/lib/node_modules/fungible/mcp/server.ts"]
    }
  }
}
```

**stdio — from source (macOS / Linux / WSL):**
```json
{
  "mcpServers": {
    "fungible": {
      "command": "node",
      "args": ["--no-warnings", "--import", "tsx/esm", "/path/to/fungible/mcp/server.ts"]
    }
  }
}
```

**HTTP (TUI must be running):**
```json
{
  "mcpServers": {
    "fungible": {
      "url": "http://localhost:3741/mcp"
    }
  }
}
```

## Available tools

Same set across MCP and HTTP.

| Tool | Description |
|------|-------------|
| `spending_summary` | Income, expenses, and breakdown by category for a given month |
| `merchant_summary` | Top merchants for a category in a date range, with totals and share of spend |
| `list_transactions` | Search and filter transactions |
| `edit_transaction` | Rename display name or change category |
| `clear_edit` | Remove a manual category or name override |
| `ignore_transaction` | Ignore / un-ignore a transaction |
| `list_rules` | List category rules |
| `add_rule` | Add a category rule |
| `delete_rule` | Delete a category rule |
| `list_name_rules` | List name rules |
| `add_name_rule` | Add a name rule |
| `delete_name_rule` | Delete a name rule |
| `list_hidden_categories` | List hidden categories |
| `toggle_hidden_category` | Show or hide a category |
| `list_accounts` | List connected accounts |
| `sync` | Pull latest transactions from Plaid |
| `uncategorized_summary` | Most common uncategorized transaction names |
| `list_tags` | List tags with transaction counts |
| `tag_summary` | Income / expenses / category breakdown for a tag |
| `tag_transaction` | Add or remove a tag on a transaction |
| `get_balances` | Current balances, net worth, total cash and liquid |
| `get_financial_health` | Runway, FIRE number, years to retirement |
| `get_drift` | Per-category spending deltas vs prior period, last year, and typical-month avg (12 complete calendar periods, elapsed-day-clipped) |
| `get_trends` | Month-by-month spending trends for the last N months |
| `get_net_worth_history` | Net worth over time grouped by day, week, month, quarter, or year |
| `get_finance_guide` | Opinionated personal finance guidance by topic |
| `get_screen` | Return the current TUI screen content exactly as the user sees it |
| `generate_canvas` | Prepare context and schema to build a Canvas; call then render with `show_canvas` |
| `show_canvas` | Render a CanvasSpec on screen 9 and save to history |
| `list_canvases` | List previously generated canvases, optionally filtered by title or prompt |
| `load_canvas` | Load a canvas from history and display it on screen 9 |
| `delete_canvas` | Delete a canvas from history |
| `calculate_tvm` | Time-value-of-money solver: given 4 of (pv, fv, pmt, n, rate), solve for the fifth |
