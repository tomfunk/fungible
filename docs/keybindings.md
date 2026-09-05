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
| `Esc` | Back / step back one filter level |

## Settings `[0]`

| Key | Action |
|-----|--------|
| `↑ ↓` | Navigate fields |
| `Enter` | Edit selected field |
| `a` | Add spouse (if none) or add child |
| `d` | Remove spouse or selected child |
| `Esc` | Back to Dashboard |

Fields: **Your name**, **Birth year**, and optionally **Spouse name**, **Spouse year**, **Child name/birth year** for each child. Editing is inline — type to update, `Enter` to confirm, `Esc` to cancel.

## Dashboard `[1]`

| Key | Action |
|-----|--------|
| `r` | Cycle time range (Week → Month → Quarter → Year → All Time) |
| `← →` | Previous / next period |
| `Tab` | Cycle views: Categories → Flex → Account picker |
| `↑ ↓` | Select category (Categories view) or account (Account view) |
| `Enter` | Drill into transactions for selected category / account |
| `Space` | Toggle account filter (Account view) |
| `c` | Clear account filter |
| `d` | Toggle delta mode (spending vs prior period / same period last year / 12-month avg) |
| `f` | Open filter panel |
| `/` | Search transactions by name (regex); filters category totals live |

In **Categories** view, spending is broken down by category with bar charts. In **Flex** view, spending is grouped by flexibility tier (fixed / flexible / discretionary / untagged). In **Account** view, select an account to filter all dashboard data to that account.

In **delta mode**, the bar chart is replaced by three delta columns — vs prev period, vs same period last year, and vs 12-month rolling average — color-coded green / yellow / red by deviation. Not available for the All Time range. An active search carries through when switching to Transactions (`2`) or Trends (`3`).

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
| `Enter` | Edit selected transaction |
| `g` | Tag panel: add/remove tags on selected transaction |
| `G` | Tag all visible transactions at once (use `/` to filter first) |
| `c` | Undo manual category override |
| `i` | Ignore / un-ignore selected transaction |
| `x` | Delete selected transaction (CSV-imported only) |
| `Esc` | Step back one filter level at a time; after a drill-in, reverses it and returns to the originating screen |

The **edit panel** has four fields navigated with `↑ ↓`: **Name** (display name override), **Category** (cycle with `← →`), **Pattern**, and **Match type**. Leave Pattern empty and `Enter` saves the change to just this transaction. Fill in Pattern and `Enter` creates a category rule (and/or name rule) that applies to all matching transactions.

## Trends `[3]`

| Key | Action |
|-----|--------|
| `← →` | Cycle views: Expenses → Income → Net → Flexibility → Fixed → Flexible → Discretionary → [each category] |
| `↑ ↓` | Navigate periods |
| `r` | Cycle aggregation range (Week / Month / Quarter / Year) |
| `Enter` | Drill into transactions for selected period |
| `f` | Open filter panel |
| `/` | Search transactions by name; hides view selector and shows net-style bars for matches |
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

Shows assets (depository, investment, manual), liabilities (credit), and net worth. History shows one snapshot per period (last sync within each bucket), scrollable with up/down.

## Tags `[5]`

| Key | Action |
|-----|--------|
| `↑ ↓` | Select tag |
| `/` | Search tags |
| `Enter` | Open tag detail (income / expenses / category breakdown) |
| `t` | View all transactions for selected tag |
| `a` | Add new tag |
| `n` | Rename selected tag |
| `x` | Delete selected tag |

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
| `r` | Reset selected dial to default |

**Dials:** Monthly spending (±$100, default = avg past 12 months), Monthly savings (±$100, default = avg surplus), Withdrawal rate (±0.5%, default = 4%), Growth rate (±1%, default = 7%).

Liquid assets = cash + brokerage (excludes 401k, IRA, pension).

## Rules `[7]`

Three sections, cycle with `Tab`: **Rules**, **Tag Rules**, **Categories**.

**Rules / Tag Rules:**

| Key | Action |
|-----|--------|
| `/` | Search rules |
| `a` | Add rule |
| `Enter` | Edit selected rule |
| `x` | Delete selected rule |

The **Rules** list shows category rules and name rules in one table — `TYPE | PATTERN | AMOUNT | CATEGORY | NAME` — and a rule that sets both a category and a display name is one row.

The **rule form** is a single panel with fields navigated by `↑ ↓`: Pattern, Match type, Min $, Max $, Category, Display name, Account. `← →` cycles/toggles the active field. A new rule opens with Category on `— none —`, so a pattern on its own is not yet saveable: `Enter` saves once there is a pattern plus a category, a display name, or both; with a pattern but neither, it moves the field cursor to Category to point at what is missing; with no pattern it does nothing. One save writes a category rule, a name rule, or both, and clearing a field on an existing rule deletes that side — set Category to `— none —` (labelled `— none (removes rule) —` while editing a rule that has a category) to drop the category rule, empty Display name to drop the name rule. `x` on a row deletes both underlying records. Matching is substring or regex with optional min/max amount filters, and applies to both halves of the rule at once.

The **tag rule form** has: Match type (`all` / `name` / `regex`), Pattern (hidden for `all`), Min $, Max $, Tag, Account. It shows a live count of the transactions that match; saving tags them, and tags you removed by hand stay removed. Deleting a tag rule leaves existing tags in place.

**Categories:**

| Key | Action |
|-----|--------|
| `a` | Add new category |
| `Enter` | Edit selected category (Name, Flexibility, Hidden — navigated with `↑ ↓`) |
| `x` | Delete category (resets affected transactions to Uncategorized) |
| `v` | Toggle hidden from list |
| `f` | Cycle flexibility tier from list: none → fixed → flexible → discretionary |

## Accounts `[8]`

| Key | Action |
|-----|--------|
| `Tab` | Cycle views: Accounts → Links → Add Data → Dupes |
| `↑ ↓` | Select account |
| `Enter` | Edit selected account (nickname, type, subtype, APR — navigated with `↑ ↓`, `← →` to cycle) |
| `v` | Update value (manual assets only) |
| `s` | Force sync (bypasses 15-min cooldown) |
| `x` | Delete selected account |
| `l` | Link a new bank account via Plaid |

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

**Add Data** options: `[l]` link bank via Plaid, `[c]` import CSV, `[m]` add manual asset (house, car, etc.), `[s]` force sync.

**Dupes** tab shows CSV transactions that match Plaid imports. `[x]` deletes the selected CSV duplicate; `[X]` deletes all.

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

**History mode** (press `/` to enter):

| Key | Action |
|-----|--------|
| `↑ ↓` | Select canvas |
| Type | Filter by title or prompt |
| `Enter` | Load selected canvas |
| `ctrl+d` | Delete selected canvas |
| `Esc` | Back to view |
