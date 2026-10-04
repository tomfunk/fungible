# Keybindings

Per-screen keyboard reference for the TUI. The desktop GUI mirrors most of these but adds mouse/click affordances and a chat drawer (backtick to toggle).

## Top-level navigation

| Key | Screen |
|-----|--------|
| `0` | Settings |
| `1` | Dashboard |
| `2` | Transactions |
| `3` | Trends |
| `4` | Net Worth |
| `5` | Tags |
| `6` | Financial Health |
| `7` | Rules |
| `8` | Accounts |
| `9` | Canvas |
| `q` | Quit |
| `f` | Filter panel (Dashboard, Transactions, Trends) |
| `h` | Toggle key hints on every screen |
| `` ` `` | Focus the agent chat (`Esc` returns when the input is empty) |
| `Esc` | Back / step back one filter level |

## Settings `[0]`

| Key | Action |
|-----|--------|
| `↑ ↓` | Navigate fields |
| `Enter` | Edit selected field |
| `a` | Add spouse (if none) or add child |
| `d` | Remove spouse or selected child |
| `← →` | Change theme (applies after restart) or toggle **Include key** (put `~/.fungible/key` in daily backups, off by default) when that row is selected |
| `Esc` | Back to Dashboard |

Fields: **Your name**, **Birth year**, and optionally **Spouse name**, **Spouse year**, **Child name/birth year** for each child. Editing is inline — type to update, `Enter` to confirm, `Esc` to cancel.

## Dashboard `[1]`

| Key | Action |
|-----|--------|
| `r` | Cycle time range (Week → Month → Quarter → Year → All Time) |
| `← →` | Previous / next period |
| `Tab` | Cycle views: Categories → Flex → Account → Owner (Owner shown once an account has an owner) |
| `↑ ↓` | Select row in the active view |
| `Enter` | Drill into transactions for the selected row |
| `m` | Top merchants for the selected category (Categories view, not in scorecard); `↑ ↓` select, `Enter` opens that merchant's transactions, `Esc` closes |
| `Space` | Toggle account filter (Account view) |
| `c` | Clear account filter (Account view) |
| `s` | Toggle scorecard — categories over / under the typical month |
| `x` | In scorecard: switch compact bars ↔ delta columns |
| `f` | Open filter panel |
| `/` | Search transactions by name (regex); filters category totals live |
| `S` | Sync all accounts now (bypasses the 15-min cooldown) |

In **Categories** view, spending is broken down by category with bar charts. In **Flex** view, spending is grouped by flexibility tier (fixed / flexible / discretionary / untagged). In **Account** view, select an account to filter all dashboard data to that account. In **Owner** view, spending is split by the owner assigned to each account.

In **scorecard** mode (`s`), categories are bucketed into OVER / TYPICAL / UNDER against their typical-month median, with a net verdict at the bottom. `x` swaps the compact bars for delta columns against three baselines — prev period, same period last year, and typical-month average (12 complete calendar periods) — color-coded green / yellow / red by deviation. Scorecard is not available for the All Time range. An active search carries through when switching to Transactions (`2`) or Trends (`3`).

## Transactions `[2]`

| Key | Action |
|-----|--------|
| `↑ ↓` | Navigate |
| `← →` | Previous / next month (when date filter active) |
| `s` | Cycle sort: Date ↓↑ → Description ↑↓ → Amount ↓↑ → Category ↑↓ |
| `/` | Search by name (regex); inherited from Dashboard if navigated with an active search |
| `f` | Open filter panel |
| `a` | Show all transactions (clears the shared filter, search, and dates) |
| `u` | Filter to Uncategorized (keeps other filter dimensions) |
| `n` | Add a transaction by hand (Date, Name, Amount, Type, Account, Category; `Enter` saves) |
| `Enter` | Edit selected transaction |
| `E` | Set one category on all visible transactions (use `/` or `f` to narrow first) |
| `g` | Tag panel: add/remove tags on selected transaction |
| `G` | Tag all visible transactions at once (use `/` to filter first) |
| `c` | Undo manual category override |
| `C` | Clear manual category overrides on all visible transactions |
| `d` | Restore the original posted date (only when the date was edited) |
| `i` | Ignore / un-ignore selected transaction (not offered for hand-added rows) |
| `I` | Ignore all visible transactions, or un-ignore them all if the selected one is already ignored |
| `x` | Delete selected transaction (CSV-imported or hand-added only) |
| `e` | Export the visible transactions to CSV |
| `S` | Sync all accounts now (bypasses the 15-min cooldown) |
| `Esc` | Step back one filter level at a time; after a drill-in, reverses it and returns to the originating screen |

`x`, `C`, `I` and the other single-key actions apply immediately with no confirmation. `E`, `C` and `I` act on every transaction currently shown, capped at the 200 rows the list loads.

`e` asks for a destination path (default `~/transactions-export-YYYY-MM-DD.csv`), then `Enter` writes it. If the file exists you are asked to overwrite (`y` / `n`). The export covers the full result for the current filter, search, and date range, not just the rows on screen.

The **edit panel** has five fields navigated with `↑ ↓`: **Name** (display name override), **Category** (cycle with `← →`), **Date** (`YYYY-MM-DD`; the original posted date stays recoverable with `d`), **Pattern**, and **Match type**. Leave Pattern empty and `Enter` saves the change to just this transaction. Fill in Pattern and `Enter` creates a category rule (and/or name rule) that applies to all matching transactions.

## Trends `[3]`

| Key | Action |
|-----|--------|
| `← →` | Cycle views: Expenses → Income → Net → Flexibility → Fixed → Flexible → Discretionary → [each category] |
| `↑ ↓` | Navigate periods |
| `r` | Cycle aggregation range (Week / Month / Quarter / Year) |
| `Enter` | Drill into transactions for selected period |
| `f` | Open filter panel |
| `/` | Search transactions by name; hides view selector and shows net-style bars for matches |
| `S` | Sync all accounts now (bypasses the 15-min cooldown) |
| `Esc` | Clear active search (or navigate back) |

## Filter panel `[f]`

Press `f` on Dashboard, Transactions, or Trends to open the session-wide filter panel. The filter has four dimensions — categories, accounts, owners, and tags — and applies to all three screens at once. Drill-ins (e.g. `Enter` on a Dashboard category) write to the same filter, and every change pushes one level of history so `Esc` can step back through it.

| Key | Action |
|-----|--------|
| `← →` | Switch section (Categories / Accounts / Owners / Tags) |
| `↑ ↓` | Move within section |
| `Space` | Toggle selected item (tags cycle: off → has → lacks) |
| `a` | Select all in section |
| `n` | Select none in section |
| `i` | Invert section (tags swap has ↔ lacks) |
| `c` | Clear all sections |
| `Enter` | Apply and close |
| `Esc` | Cancel without applying |

Everything selected in a section means "no constraint" for that dimension. The filter is session-only — it resets on restart.

## Net Worth `[4]`

| Key | Action |
|-----|--------|
| `Tab` | Toggle: by account ↔ by type |
| `r` | Cycle history range (Week / Month / Quarter / Year) |
| `↑ ↓` | Scroll history |
| `f` | Filter the chart by account or type (depends on the current view) |

In the filter, `↑ ↓` moves, `Space` toggles the selected account (or type), `a` includes everything again, and `f` or `Esc` closes it. With nothing toggled, everything is included.

Shows assets (depository, investment, manual), liabilities (credit), and net worth. History shows one snapshot per period (last sync within each bucket), scrollable with up/down. To fill in earlier history, see [Importing balance history](#importing-balance-history) (Accounts → Add Data → `[b]`).

## Tags `[5]`

| Key | Action |
|-----|--------|
| `↑ ↓` | Select tag |
| `/` | Search tags |
| `s` | Cycle sort: name → most recent → oldest |
| `Enter` | Open tag detail (income / expenses / category breakdown) |
| `t` | View all transactions for selected tag |
| `a` | Add new tag |
| `n` | Rename selected tag |
| `x` | Delete selected tag (immediately, no confirmation) |

In tag detail, `↑ ↓` selects a category and `Enter` drills into transactions for that tag + category. `← →` cycles to the previous/next tag.

## Financial Health `[6]`

Displays a full financial picture across four sections:

- **Snapshot** — savings rate (color-coded) and estimated monthly income
- **Runway** — months of cash and liquid coverage at current spending
- **Debt** — net cash position (checking minus credit debt), months to debt-free at current savings rate (hidden if no debt)
- **Retirement** — net worth, FIRE number with progress bar, Coast FIRE (years until growth alone covers retirement if you stop saving now), estimated years to FIRE

| Key | Action |
|-----|--------|
| `↑ ↓` | Select assumption dial |
| `← →` | Adjust selected dial value |
| `Enter` | Type a value for the selected dial (`Enter` confirm, `Esc` cancel) |
| `r` | Reset selected dial to default |
| `t` | History view (`t` or `Esc` to close) |

**Dials:** Monthly spending (±$100, default = avg past 12 months), Monthly savings (±$100, default = avg surplus), Pretax savings (±$100, default $0), Withdrawal rate (±0.5%, default = 4%), Growth rate (±1%, default = 7%).

**Pretax savings** is for 401k/HSA contributions that never show up in transactions. It is added to income when computing the savings rate (the take-home rate is shown alongside) and to savings when estimating years to FIRE. Unlike the other dials it is saved (settings key `pretax_monthly`) and survives restarts.

**History** charts one metric per period, newest at the bottom: `← →` switches metric (savings rate, cash runway, liquid runway, debt payoff, retirement balance, years to FIRE, Coast FIRE), `↑ ↓` scrolls, `r` cycles the range (Week / Month / Quarter / Year). Years to FIRE and Coast FIRE apply today's growth and withdrawal assumptions to each period's past balance.

Liquid assets = cash + brokerage (excludes 401k, IRA, pension).

## Rules `[7]`

Three sections, cycle with `Tab`: **Rules**, **Tag Rules**, **Categories**.

**Rules / Tag Rules:**

| Key | Action |
|-----|--------|
| `↑ ↓` | Navigate |
| `/` | Search rules |
| `a` | Add rule |
| `Enter` | Edit selected rule |
| `x` | Delete selected rule (immediately, no confirmation) |

The **Rules** list shows category rules and name rules in one table — `TYPE | PATTERN | AMOUNT | CATEGORY | NAME` — and a rule that sets both a category and a display name is one row. A rule scoped to one account shows `@account` at the end of its row.

The **rule form** is a single panel with fields navigated by `↑ ↓`: Pattern, Match type, Min $, Max $, Category, Display name, Account. `← →` cycles/toggles the active field; **Account** scopes the rule to a single account and defaults to all of them.

A new rule opens with Category on `— none —`, so a pattern on its own is not yet saveable: `Enter` saves once there is a pattern plus a category, a display name, or both; with a pattern but neither, it moves the field cursor to Category to point at what is missing; with no pattern it does nothing. One save writes a category rule, a name rule, or both, and clearing a field on an existing rule deletes that side — set Category to `— none —` (labelled `— none (removes rule) —` while editing a rule that has a category) to drop the category rule, empty Display name to drop the name rule. `x` on a row deletes both underlying records. Matching is substring or regex with optional min/max amount filters, and applies to both halves of the rule at once.

The **tag rule form** has: Match type (`all` / `name` / `regex`), Pattern (hidden for `all`), Min $, Max $, Tag, Account. It shows a live count of the transactions that match; saving tags them, and tags you removed by hand stay removed. Deleting a tag rule leaves existing tags in place.

**Categories:**

| Key | Action |
|-----|--------|
| `↑ ↓` | Select category |
| `a` | Add new category |
| `Enter` | Edit selected category (Name, Flexibility, Hidden — navigated with `↑ ↓`) |
| `x` | Delete category immediately, no confirmation (resets affected transactions to Uncategorized) |
| `v` | Toggle hidden from list |
| `f` | Cycle flexibility tier from list: none → fixed → flexible → discretionary |

## Accounts `[8]`

| Key | Action |
|-----|--------|
| `Tab` | Cycle views: Accounts → Links → Add Data → Dupes |
| `↑ ↓` | Select account |
| `Enter` | Edit selected account (nickname, owner, type, subtype, APR, excluded — navigated with `↑ ↓`, `← →` to cycle; owner appears once household members exist) |
| `v` | Update value (manual assets only) |
| `s` | Force sync (bypasses 15-min cooldown) |
| `x` | Delete selected account (asks `y` / `n`) |

**Links** tab lists one row per Plaid connection rather than per account, since a
single connection can back many accounts.

| Key | Action |
|-----|--------|
| `↑ ↓` | Select connection |
| `u` | Update link — update creds for link, keeping its accounts and transactions |
| `d` | Delete sync cursor — re-download this connection's full history (free) |
| `r` | Refresh — ask this bank for new transactions now (Plaid charges) |
| `s` | Force sync (bypasses 15-min cooldown) |

`[u]` runs Plaid in update mode, which re-authorizes the existing connection in
place. Use it when a connection shows ⚠ sync failed because its login expired.
It does not create new accounts or re-download transactions, and it cannot widen
the history window — that is fixed when the connection is first created.

`[d]` and `[r]` both go after missing transactions, but they fix different
causes, and only one of them costs money.

`[d]` deletes the stored `/transactions/sync` cursor, so the next sync starts
from the beginning of the item's history and Plaid resends everything it holds.
Use it to recover rows this app lost while Plaid kept them — an account you
deleted, transactions you deleted, or a database rebuilt against a live
connection. Writes are upserts, so existing rows are updated rather than
duplicated and manual categories and tags survive. Two things to know: a
transaction you deleted by hand comes back (nothing records that you meant it
gone), and anything Plaid itself no longer has stays gone, including the rows
this app deleted *because* Plaid reported them removed. Plaid does not bill for
it; the cost is the time the resync takes. A connection with no stored cursor
shows `· sync cursor cleared` until its next sync.

`[r]` calls `/transactions/refresh`, asking the bank to run an extraction right
now rather than waiting for its next scheduled one, then polls for about four
minutes to see what lands (`Esc` stops the polling). **Plaid bills per call on
most plans.** It only reaches transactions the bank has not reported yet —
roughly the last day — and cannot widen the history window. If what you are
missing is older than that, Plaid almost certainly already has it, which makes
`[d]` the free fix and `[r]` a wasted charge.

To link a new bank, use Add Data. **Add Data** options: `[l]` link bank via Plaid, `[c]` import CSV, `[b]` import balance history, `[m]` add manual asset (house, car, etc.), `[s]` force sync.

**Import history** appears on the Add Data view once a CSV has been imported. `↑↓` selects an import; `[u]` undoes it, removing the transactions it created and the record of it; `[v]` moves it to a different account, for a file imported into the wrong one. Both confirm first — undo names any categories, renames, or tags of yours that would be lost.

**Dupes** tab shows CSV transactions that match Plaid imports. `[x]` deletes the selected CSV duplicate; `[X]` deletes all. Both act immediately, with no confirmation.

### Importing balance history

`[b]` on Add Data imports past balances for accounts you already track, to fill in the Net Worth chart. Enter a CSV path, review the preview (nothing is written yet), then `Enter` to import. There is no undo.

```csv
date,account,balance
2024-01-31,Chase Checking,4210.55
2024-01-31,Visa,"$1,250.00"
2024-02-29,Chase Checking,(50.00)
```

- Header `date,account,balance` is required; case-insensitive, any column order, extra columns ignored. Dates are `YYYY-MM-DD`.
- Balances accept `$`, commas, `(50.00)` and `-50`. For credit cards and loans, enter the amount owed as a positive number (a negative one triggers a warning).
- Accounts match by name or nickname (case-insensitive). Unmatched or ambiguous names are skipped; press `[m]` in the preview to map them to an existing account for this import only. Accounts are never created.
- Only rows older than an account's current latest balance are imported, so today's balance is unchanged. Newer or future rows are skipped.
- A row replaces any existing balance for the same account and date, so re-importing a file is safe. Repeated rows in one file: the last wins.
- Net worth history leaves out an account for any period where it has no balance, so a partial import can make the chart jump.

The same flow is in the desktop app (Accounts, Add data, "Import balance history") and is available to the agent and MCP clients as `preview_balance_import` and `import_balance_history`.

## Canvas `[9]`

An AI-generated financial calculator, built on demand by the agent. Ask the agent (`` ` ``) to generate a canvas — e.g. "make a loan payoff calculator" — and it will appear here with interactive dials.

**View mode** (when a canvas is loaded):

| Key | Action |
|-----|--------|
| `↑ ↓` | Select dial |
| `← →` | Adjust selected dial by its step |
| `Enter` | Type a value directly for selected dial |
| `r` | Reset selected dial to default |
| `/` | Open history browser |
| `Esc` | Back to Dashboard |

Canvases with editable lists (e.g. income or expense rows) add: `Enter` edits the selected cell, `a` adds a row, `d` deletes the selected row, and `← →` steps a start or end year.

**History mode** (press `/` to enter):

| Key | Action |
|-----|--------|
| `↑ ↓` | Select canvas |
| Type | Filter by title or prompt |
| `Enter` | Load selected canvas |
| `ctrl+d` | Delete selected canvas |
| `Esc` | Back to view |
