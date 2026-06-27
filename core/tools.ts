/**
 * Shared tool definitions and executor used by both the embedded agent (core/agent.ts)
 * and the MCP server (mcp/server.ts).
 *
 * executeTool returns a plain string — callers wrap it as needed (MCP content block,
 * tool_result message, etc.). Confirmation and navigation are NOT handled here; the
 * embedded agent handles those before calling executeTool.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notifyChange } from './refresh.js';
import { DATA_DIR } from './paths.js';
import { getRangeSummary, getMonthlySummary, getTagSummary, getCategoryDriftData, getMerchantSummary, getNetWorthHistory, type NetWorthGranularity } from './queries.js';
import { solveTVM } from './calculator.js';
import { getDriftWindows } from './dateUtils.js';
import { getBalances, getFinancialHealth, getSpendingTrends } from './agent-context.js';
import { getFinanceGuide, getFinanceTopicList, formatGuideSection, type GuideTopic } from './finance-guide.js';
import { applyCategoriesToAll } from './categorize.js';
import { rebuildDisplayNames } from './rename.js';
import { setTransactionCategory, clearTransactionOverride, setTransactionIgnored } from './transactions.js';
import { addTagToTransaction, removeTagFromTransaction, getOrCreateTag } from './tags.js';
import { fmt, fmtSigned } from './fmt.js';
import { syncAll } from './sync.js';
import { db } from './db.js';
import { validateRegex } from './rule-utils.js';
import type { ToolDef } from './llm-provider.js';

import { CANVAS_SPEC_PATH, appendHistory, searchHistory, getHistoryEntry, deleteHistoryEntry } from './canvas-history.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Keep in sync with executeTool — any tool that mutates data must be listed here
// or TUI refresh and afterWrite callbacks will be silently skipped for that tool.
export const WRITE_TOOLS = new Set([
  'edit_transaction', 'clear_edit', 'ignore_transaction',
  'add_rule', 'delete_rule', 'add_name_rule', 'delete_name_rule',
  'tag_transaction', 'toggle_hidden_category', 'sync',
  'show_canvas', 'load_canvas', 'delete_canvas',
]);

// ─── Tool definitions (all except the agent-only `show` tool) ─────────────────

export const TOOL_DEFS: ToolDef[] = [
  // ── Data / read ────────────────────────────────────────────────────────────

  {
    name: 'spending_summary',
    description: 'Get income, expenses, net, and spending by category. Provide either (year + month) for a specific month, or (from + to) for a date range.',
    parameters: {
      type: 'object',
      properties: {
        year:  { type: 'integer', description: '4-digit year' },
        month: { type: 'integer', description: 'Month 1–12', minimum: 1, maximum: 12 },
        from:  { type: 'string',  description: 'Start date YYYY-MM-DD' },
        to:    { type: 'string',  description: 'End date YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'merchant_summary',
    description: 'Get top merchants for a category in a date range, with total amount, transaction count, and share of category spend.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category name, e.g. "Food & Drink"' },
        year:     { type: 'integer', description: '4-digit year' },
        month:    { type: 'integer', description: 'Month 1–12', minimum: 1, maximum: 12 },
        from:     { type: 'string',  description: 'Start date YYYY-MM-DD' },
        to:       { type: 'string',  description: 'End date YYYY-MM-DD' },
      },
      required: ['category'],
    },
  },
  {
    name: 'list_transactions',
    description: 'List transactions with optional filters. Returns date, name, amount, category, account, and ID.',
    parameters: {
      type: 'object',
      properties: {
        category:        { type: 'string',  description: 'Filter by category name' },
        year:            { type: 'integer', description: '4-digit year (use with month)' },
        month:           { type: 'integer', description: 'Month 1–12 (use with year)', minimum: 1, maximum: 12 },
        from:            { type: 'string',  description: 'Start date YYYY-MM-DD' },
        to:              { type: 'string',  description: 'End date YYYY-MM-DD' },
        search:          { type: 'string',  description: 'Search within transaction name' },
        include_ignored: { type: 'boolean', description: 'Include ignored transactions (default false)' },
        limit:           { type: 'integer', description: 'Max results (default 50)', minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: 'list_accounts',
    description: 'List all connected accounts (banks, credit cards, manual assets).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_balances',
    description: 'Get current balances for all accounts, plus net worth, total cash, and total liquid assets.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_financial_health',
    description: 'Get financial health metrics: cash and liquid runway months, FIRE number, progress, and estimated years to retirement.',
    parameters: {
      type: 'object',
      properties: {
        withdrawal_rate: { type: 'number', description: 'Safe withdrawal rate % (default 4)', minimum: 0.5, maximum: 10 },
        growth_rate:     { type: 'number', description: 'Expected annual growth rate % (default 7)', minimum: 0, maximum: 20 },
      },
    },
  },
  {
    name: 'get_drift',
    description: 'Show spending deltas for each category: current amount vs prior period, same period last year, and 12-month rolling average. Useful for spotting categories where spending is quietly creeping up. Defaults to the current month-to-date.',
    parameters: {
      type: 'object',
      properties: {
        year:  { type: 'integer', description: '4-digit year (default: current year)' },
        month: { type: 'integer', description: 'Month 1–12 (default: current month)', minimum: 1, maximum: 12 },
        day:   { type: 'integer', description: 'Day of month to compare through — use for partial-month MTD (default: today)', minimum: 1, maximum: 31 },
      },
    },
  },
  {
    name: 'get_trends',
    description: 'Month-by-month spending trends for the last N months. Optionally filter to a specific category.',
    parameters: {
      type: 'object',
      properties: {
        months:   { type: 'integer', description: 'Months to look back (default 12)', minimum: 1, maximum: 60 },
        category: { type: 'string',  description: 'Category name to track (omit for overall)' },
      },
    },
  },
  {
    name: 'list_rules',
    description: 'List all category rules.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_name_rules',
    description: 'List all name rules (rules that rename transaction display names).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_hidden_categories',
    description: 'List categories hidden from totals and charts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_tags',
    description: 'List all tags with transaction counts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tag_summary',
    description: 'Get income, expenses, net, and category breakdown for all transactions with a given tag.',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Tag name' },
      },
      required: ['tag'],
    },
  },
  {
    name: 'uncategorized_summary',
    description: 'Show the most common uncategorized transaction names, useful for writing new rules.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max results (default 30)', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'get_finance_guide',
    description: 'Get opinionated personal finance guidance. Omit topic for an overview; provide a topic for detailed advice.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic to retrieve',
          enum: ['priorities', 'emergency-fund', 'debt', 'employer-match', 'hsa', 'ira', '401k', 'investing', 'budgeting', 'fire', 'housing', 'car', 'insurance'],
        },
      },
    },
  },
  {
    name: 'get_net_worth_history',
    description: 'Net worth over time, grouped by day, week, month, quarter, or year. Returns assets, liabilities, and net worth for each period.',
    parameters: {
      type: 'object',
      properties: {
        granularity: {
          type: 'string',
          description: 'Time grouping: day, week, month (default), quarter, or year',
          enum: ['day', 'week', 'month', 'quarter', 'year'],
        },
      },
    },
  },
  {
    name: 'calculate_tvm',
    description: 'Time Value of Money solver. Provide any 4 of 5 variables (pv, fv, pmt, n, rate) and it solves for the missing one. Rate is the periodic rate (e.g. monthly rate = annual% / 1200). Sign convention: outflows negative, inflows positive.',
    parameters: {
      type: 'object',
      properties: {
        pv:   { type: 'number', description: 'Present value. Positive = cash received, negative = cash paid out.' },
        fv:   { type: 'number', description: 'Future value. Positive = cash received, negative = cash paid out.' },
        pmt:  { type: 'number', description: 'Periodic payment. Negative if you are paying, positive if receiving.' },
        n:    { type: 'number', description: 'Number of periods (e.g. months for a monthly-rate problem).' },
        rate: { type: 'number', description: 'Interest/growth rate per period (decimal, e.g. 0.005 for 0.5%/month = 6%/year).' },
      },
    },
  },

  // ── Write (require confirmation in the agent) ──────────────────────────────

  {
    name: 'edit_transaction',
    description: 'Manually set the category for a specific transaction (pins it — survives re-syncs). Use list_transactions to get the ID.',
    parameters: {
      type: 'object',
      properties: {
        id:       { type: 'string', description: 'Transaction ID' },
        category: { type: 'string', description: 'Category to assign' },
      },
      required: ['id', 'category'],
    },
  },
  {
    name: 'clear_edit',
    description: 'Remove a manual category override from a transaction, reverting to rule-based categorization.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Transaction ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'ignore_transaction',
    description: 'Toggle the ignored flag on a transaction. Ignored transactions are hidden from totals and charts.',
    parameters: {
      type: 'object',
      properties: {
        id:     { type: 'string',  description: 'Transaction ID' },
        ignore: { type: 'boolean', description: 'true to ignore, false to un-ignore' },
      },
      required: ['id', 'ignore'],
    },
  },
  {
    name: 'add_rule',
    description: 'Add a category rule and immediately apply it to all transactions.',
    parameters: {
      type: 'object',
      properties: {
        pattern:    { type: 'string', description: 'Text to match against transaction name' },
        match_type: { type: 'string', description: '"name" for substring, "regex" for regex', enum: ['name', 'regex'] },
        category:   { type: 'string', description: 'Category to assign' },
        priority:   { type: 'integer', description: 'Higher priority runs first (default 10)' },
        min_amount: { type: 'number', description: 'Minimum transaction amount (optional)' },
        max_amount: { type: 'number', description: 'Maximum transaction amount (optional)' },
      },
      required: ['pattern', 'match_type', 'category'],
    },
  },
  {
    name: 'delete_rule',
    description: 'Delete a category rule by ID. Use list_rules to find the ID.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Rule ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_name_rule',
    description: 'Add a name rule that renames how transactions display.',
    parameters: {
      type: 'object',
      properties: {
        pattern:     { type: 'string', description: 'Text or regex to match' },
        match_type:  { type: 'string', description: '"name" for substring, "regex" for regex', enum: ['name', 'regex'] },
        replacement: { type: 'string', description: 'Display name to show instead' },
        min_amount:  { type: 'number', description: 'Minimum transaction amount (optional)' },
        max_amount:  { type: 'number', description: 'Maximum transaction amount (optional)' },
      },
      required: ['pattern', 'match_type', 'replacement'],
    },
  },
  {
    name: 'delete_name_rule',
    description: 'Delete a name rule by ID.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Name rule ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tag_transaction',
    description: 'Add or remove a tag on a transaction.',
    parameters: {
      type: 'object',
      properties: {
        id:  { type: 'string',  description: 'Transaction ID' },
        tag: { type: 'string',  description: 'Tag name' },
        add: { type: 'boolean', description: 'true to add, false to remove' },
      },
      required: ['id', 'tag', 'add'],
    },
  },
  {
    name: 'toggle_hidden_category',
    description: 'Add or remove a category from the hidden list. Hidden categories are excluded from all totals.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string',  description: 'Category name' },
        hide:     { type: 'boolean', description: 'true to hide, false to unhide' },
      },
      required: ['category', 'hide'],
    },
  },
  {
    name: 'sync',
    description: 'Sync latest transactions from Plaid for all connected accounts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'show_canvas',
    description: 'Render a CanvasSpec in the app\'s Canvas screen (screen 9) and save it to history. The TUI auto-navigates to canvas. Always pass the original user prompt so the canvas is findable later.',
    parameters: {
      type: 'object',
      properties: {
        spec:   { type: 'string', description: 'JSON-encoded CanvasSpec (title + elements array)' },
        prompt: { type: 'string', description: 'The original user question that generated this canvas' },
      },
      required: ['spec', 'prompt'],
    },
  },
  {
    name: 'get_screen',
    description: 'Return the current text content of the TUI exactly as the user sees it. Use this to understand what screen the user is on and what is displayed before navigating or generating canvases.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_canvases',
    description: 'List previously generated canvases from history. Optionally filter by title or prompt text.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter by title or prompt (optional)' },
      },
    },
  },
  {
    name: 'load_canvas',
    description: 'Load a previously generated canvas from history and display it on screen 9.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Canvas history ID from list_canvases' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_canvas',
    description: 'Delete a canvas from history by ID.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Canvas history ID from list_canvases' },
      },
      required: ['id'],
    },
  },
];

// ─── Human-readable write tool descriptions (for confirmation prompts) ─────────

export function describeToolCall(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => String(input[k] ?? '');
  const n = (k: string) => Number(input[k] ?? 0);
  switch (name) {
    case 'edit_transaction':       return `Set transaction category to "${s('category')}" [id: ${s('id')}]`;
    case 'clear_edit':             return `Remove manual category override [id: ${s('id')}]`;
    case 'ignore_transaction':     return `${input['ignore'] ? 'Ignore' : 'Un-ignore'} transaction [id: ${s('id')}]`;
    case 'add_rule':               return `Add category rule: "${s('pattern')}" → ${s('category')}`;
    case 'delete_rule':            return `Delete category rule #${n('id')}`;
    case 'add_name_rule':          return `Add name rule: "${s('pattern')}" → "${s('replacement')}"`;
    case 'delete_name_rule':       return `Delete name rule #${n('id')}`;
    case 'tag_transaction':        return `${input['add'] ? 'Add' : 'Remove'} tag #${s('tag')} on transaction [id: ${s('id')}]`;
    case 'toggle_hidden_category': return `${input['hide'] ? 'Hide' : 'Unhide'} category "${s('category')}"`;
    case 'sync':                   return 'Sync transactions from Plaid';
    default:                       return name;
  }
}

// ─── Pure tool executor ───────────────────────────────────────────────────────

/**
 * Execute a tool by name and return a plain-text result string.
 * Does not handle `show` (agent-only), confirmation, or MCP wrapping.
 */
async function executeToolImpl(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const str  = (k: string, def = '') => String(input[k] ?? def);
  const num  = (k: string, def = 0)  => Number(input[k] ?? def);
  const bool = (k: string)            => Boolean(input[k]);
  const opt  = (k: string)            => input[k] !== undefined ? Number(input[k]) : null;

  switch (name) {

    // ── Read tools ────────────────────────────────────────────────────────────

    case 'spending_summary': {
      const from = str('from'); const to = str('to');
      const year = num('year'); const month = num('month');
      let summary; let label: string;
      if (from && to) {
        summary = await getRangeSummary(from, to);
        label = `${from} – ${to}`;
      } else if (year && month) {
        summary = await getMonthlySummary(year, month);
        label = `${new Date(year, month - 1).toLocaleString('en-US', { month: 'long' })} ${year}`;
      } else {
        return 'Provide either (year + month) or (from + to).';
      }
      return [
        `## ${label}`,
        `Income: $${summary.income.toFixed(2)}`,
        `Expenses: $${summary.expenses.toFixed(2)}`,
        `Net: ${summary.net >= 0 ? '+' : ''}$${summary.net.toFixed(2)}`,
        '',
        'By category:',
        ...summary.byCategory.map((c) => `  ${c.category}: $${c.total.toFixed(2)}`),
      ].join('\n');
    }

    case 'merchant_summary': {
      const category = str('category');
      if (!category) return "Provide 'category'.";

      const from = str('from'); const to = str('to');
      const year = num('year'); const month = num('month');
      const accountId = str('account_id') || undefined;
      const acctFilter = accountId ? { accounts: [accountId] } : undefined;

      const fmtRows = (rows: Awaited<ReturnType<typeof getMerchantSummary>>, label: string) => {
        if (!rows.length) return `No merchant spend found for "${category}" in ${label}.`;
        return [`## ${category} · ${label}`, ...rows.map((r) => `${r.merchant}  $${r.total.toFixed(2)}  ${r.count} txn${r.count === 1 ? '' : 's'}  ${(r.pct * 100).toFixed(1)}%`)].join('\n');
      };

      if (from && to) {
        return fmtRows(await getMerchantSummary(category, from, to, acctFilter), `${from} – ${to}`);
      }
      if (year && month) {
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end   = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
        return fmtRows(await getMerchantSummary(category, start, end, acctFilter), `${new Date(year, month - 1).toLocaleString('en-US', { month: 'long' })} ${year}`);
      }
      return "Provide either (year + month) or (from + to).";
    }

    case 'list_transactions': {
      const conditions: string[] = ['t.pending = 0'];
      const args: (string | number)[] = [];
      if (!bool('include_ignored')) conditions.push('t.ignored = 0');
      if (input['category']) { conditions.push('t.category = ?'); args.push(str('category')); }
      if (input['from'] && input['to']) {
        conditions.push('t.date >= ? AND t.date <= ?'); args.push(str('from'), str('to'));
      } else if (input['month'] && input['year']) {
        const yr = num('year'); const mo = num('month');
        const from = `${yr}-${String(mo).padStart(2, '0')}-01`;
        const lastDay = new Date(yr, mo, 0).getDate();
        const to = `${yr}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        conditions.push('t.date >= ? AND t.date <= ?');
        args.push(from, to);
      }
      if (input['search']) {
        conditions.push('(t.name LIKE ? OR t.display_name LIKE ?)');
        args.push(`%${str('search')}%`, `%${str('search')}%`);
      }
      const where = 'WHERE ' + conditions.join(' AND ');
      const limit = input['limit'] ? num('limit') : 50;
      const result = await db.execute({
        sql: `
          SELECT t.id, t.date, COALESCE(t.display_name, t.name) as name, t.amount,
                 t.category, t.manual_category, t.ignored, COALESCE(a.nickname, a.name) as account
          FROM transactions t LEFT JOIN accounts a ON t.account_id = a.id
          ${where} ORDER BY t.date DESC LIMIT ?
        `,
        args: [...args, limit],
      });
      const rows = result.rows as unknown as {
        id: string; date: string; name: string; amount: number;
        category: string; manual_category: string | null; ignored: number; account: string;
      }[];
      if (!rows.length) return 'No transactions found.';
      return rows.map((r) => {
        const sign  = r.amount < 0 ? '+' : '-';
        const flags = (r.manual_category ? '◆' : ' ') + (r.ignored ? '~' : ' ');
        return `${r.date}  ${flags}  ${r.name.slice(0, 36).padEnd(36)}  ${sign}$${Math.abs(Number(r.amount)).toFixed(2).padStart(9)}  ${r.category}  [${r.id}]`;
      }).join('\n');
    }

    case 'list_accounts': {
      const result = await db.execute(
        'SELECT COALESCE(nickname, name) as name, type, subtype, mask, institution_name, excluded FROM accounts'
      );
      const rows = result.rows as unknown as {
        name: string; type: string; subtype: string; mask: string | null; institution_name: string | null; excluded: number;
      }[];
      if (!rows.length) return 'No accounts connected.';
      return rows.map((a) =>
        `${a.name} (${a.subtype ?? a.type}) ···${a.mask ?? '?'} — ${a.institution_name ?? 'Unknown'}`
        + (Number(a.excluded) === 1 ? ' · excluded from net worth' : '')
      ).join('\n');
    }

    case 'get_balances': {
      const b = await getBalances();
      if (!b.accounts.length && !b.excludedAccounts.length) return 'No balance data available. Sync accounts first.';
      return [
        'Assets:',
        ...b.accounts.filter((a) => a.isAsset).map((a) => `  ${a.name}: ${fmt(a.balance)} (${a.subtype ?? a.type})`),
        `  Total assets: ${fmt(b.totalAssets)}`,
        'Liabilities:',
        ...b.accounts.filter((a) => a.isLiability).map((a) => `  ${a.name}: ${fmt(a.balance)}`),
        `  Total liabilities: ${fmt(b.totalLiabilities)}`,
        `Net worth: ${b.netWorth >= 0 ? '' : '-'}${fmt(b.netWorth)}`,
        `Cash (checking/savings): ${fmt(b.cash)}`,
        `Liquid (incl. brokerage): ${fmt(b.liquid)}`,
        ...(b.excludedAccounts.length ? [
          'Excluded (not in net worth):',
          ...b.excludedAccounts.map((a) => `  ${a.name}: ${fmt(a.balance)} (${a.subtype ?? a.type})`),
        ] : []),
      ].join('\n');
    }

    case 'get_financial_health': {
      const h = await getFinancialHealth(
        input['withdrawal_rate'] ? num('withdrawal_rate') : 4,
        input['growth_rate']     ? num('growth_rate')     : 7,
      );
      const fmtM = (n: number) => Number.isFinite(n) && n < 999 ? `${n.toFixed(1)} months` : '∞';
      return [
        `Net worth: ${h.netWorth >= 0 ? '' : '-'}${fmt(h.netWorth, 0)}`,
        `Cash runway: ${fmtM(h.cashRunwayMonths)} (${fmt(h.cash, 0)} in checking/savings)`,
        `Liquid runway: ${fmtM(h.liquidRunwayMonths)} (${fmt(h.liquid, 0)} incl. brokerage)`,
        `Avg monthly expenses (12 mo): ${fmt(h.avgMonthlyExpenses, 0)}`,
        `Avg monthly savings (12 mo): ${fmt(h.avgMonthlySavings, 0)}`,
        `FIRE number: ${fmt(h.fireNumber, 0)}`,
        `FIRE progress: ${(h.fireProgress * 100).toFixed(1)}%`,
        `Years to FIRE: ${h.yearsToFire === null ? '100+' : h.yearsToFire === 0 ? 'Achieved!' : `~${Math.ceil(h.yearsToFire)}`}`,
      ].join('\n');
    }

    case 'get_drift': {
      const today = new Date();
      const year  = input['year']  ? num('year')  : today.getFullYear();
      const month = input['month'] ? num('month') : today.getMonth() + 1;
      const day   = input['day']   ? num('day')   : today.getDate();
      const anchor = new Date(year, month - 1, 1, 12);
      const asOf   = new Date(year, month - 1, day, 12);
      const windows = getDriftWindows('month', anchor, asOf);
      if (!windows) return 'Drift is not available for this range.';
      const { current, lastPeriod, lastYear, rolling12 } = windows;
      const rows = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
      if (!rows.length) return `No expense data for ${year}-${String(month).padStart(2, '0')} through day ${day}.`;
      const fmtAmt   = (n: number) => fmt(n, 0);
      const signedFmt = (n: number) => n === 0 ? '—' : fmtSigned(n, 0);
      const heat = (current: number, avg: number) => {
        if (avg === 0) return current > 0 ? ' 🔴' : '';
        const r = current / avg;
        if (r <= 1.10) return ' 🟢';
        if (r <= 1.30) return ' 🟡';
        return ' 🔴';
      };
      const header = `Drift — ${year}-${String(month).padStart(2, '0')} through day ${day}\n` +
        `${'Category'.padEnd(26)} ${'Current'.padStart(10)} ${'vs Last'.padStart(10)} ${'vs Yr'.padStart(10)} ${'vs 12m'.padStart(10)}`;
      const divider = '─'.repeat(header.split('\n')[1].length);
      const lines = rows.map((r) =>
        `${r.category.length > 26 ? r.category.slice(0, 25) + '…' : r.category.padEnd(26)} ` +
        `${fmtAmt(r.current).padStart(10)} ` +
        `${signedFmt(r.lastPeriodDelta).padStart(10)} ` +
        `${signedFmt(r.lastYearDelta).padStart(10)} ` +
        `${signedFmt(r.avg12mDelta).padStart(10)}` +
        heat(r.current, r.avg12m)
      );
      return [header.split('\n')[0], divider, header.split('\n')[1], divider, ...lines].join('\n');
    }

    case 'get_trends': {
      const rows = await getSpendingTrends(input['months'] ? num('months') : 12, input['category'] ? str('category') : undefined);
      if (!rows.length) return 'No data.';
      const hasCat = Boolean(input['category']);
      const header = hasCat
        ? `Month         ${str('category').padStart(12)}  Expenses      Income        Net`
        : 'Month         Expenses      Income        Net';
      const dataLines = rows.map((r) => hasCat
        ? `${r.label.padEnd(14)}${fmt(r.categoryTotal ?? 0, 0).padStart(12)}  ${fmt(r.expenses, 0).padStart(12)}  ${fmt(r.income, 0).padStart(12)}  ${(r.net >= 0 ? '+' : '') + fmt(r.net, 0)}`
        : `${r.label.padEnd(14)}${fmt(r.expenses, 0).padStart(12)}  ${fmt(r.income, 0).padStart(12)}  ${(r.net >= 0 ? '+' : '') + fmt(r.net, 0)}`
      );
      return [header, '─'.repeat(header.length), ...dataLines].join('\n');
    }

    case 'list_rules': {
      const result = await db.execute(
        'SELECT id, priority, match_type, pattern, category, min_amount, max_amount FROM category_rules ORDER BY priority DESC, id ASC'
      );
      const rules = result.rows as unknown as {
        id: number; priority: number; match_type: string; pattern: string;
        category: string; min_amount: number | null; max_amount: number | null;
      }[];
      if (!rules.length) return 'No rules defined.';
      return rules.map((r) => {
        const amt = r.min_amount != null && r.max_amount != null
          ? ` [$${r.min_amount}–$${r.max_amount}]`
          : r.min_amount != null ? ` [≥$${r.min_amount}]`
          : r.max_amount != null ? ` [≤$${r.max_amount}]` : '';
        return `[${r.id}] pri=${r.priority} ${r.match_type.padEnd(5)} "${r.pattern}"${amt} → ${r.category}`;
      }).join('\n');
    }

    case 'list_name_rules': {
      const result = await db.execute(
        'SELECT id, match_type, pattern, replacement, min_amount, max_amount FROM name_rules ORDER BY id ASC'
      );
      const rules = result.rows as unknown as {
        id: number; match_type: string; pattern: string;
        replacement: string; min_amount: number | null; max_amount: number | null;
      }[];
      if (!rules.length) return 'No name rules defined.';
      return rules.map((r) => {
        const amt = r.min_amount != null ? ` [≥$${r.min_amount}]` : r.max_amount != null ? ` [≤$${r.max_amount}]` : '';
        return `[${r.id}] ${r.match_type.padEnd(5)} "${r.pattern}"${amt} → "${r.replacement}"`;
      }).join('\n');
    }

    case 'list_hidden_categories': {
      const result = await db.execute('SELECT category FROM hidden_categories ORDER BY category');
      const rows = result.rows as unknown as { category: string }[];
      return rows.length ? rows.map((r) => r.category).join('\n') : 'No hidden categories.';
    }

    case 'list_tags': {
      const result = await db.execute(`
        SELECT t.name, COUNT(tt.transaction_id) as count
        FROM tags t LEFT JOIN transaction_tags tt ON tt.tag_id = t.id
        GROUP BY t.id ORDER BY t.name
      `);
      const rows = result.rows as unknown as { name: string; count: number }[];
      return rows.length
        ? rows.map((r) => `${r.name.padEnd(30)} ${r.count} txn${r.count !== 1 ? 's' : ''}`).join('\n')
        : 'No tags defined.';
    }

    case 'tag_summary': {
      const summary = await getTagSummary(str('tag'));
      return [
        `#${str('tag')}`,
        `Income: $${summary.income.toFixed(2)}  Expenses: $${summary.expenses.toFixed(2)}  Net: ${summary.net >= 0 ? '+' : ''}$${summary.net.toFixed(2)}`,
        '',
        'By category:',
        ...(summary.byCategory.length
          ? summary.byCategory.map((c) => `  ${c.category}: $${c.total.toFixed(2)}`)
          : ['  (none)']),
      ].join('\n');
    }

    case 'uncategorized_summary': {
      const limit = input['limit'] ? num('limit') : 30;
      const result = await db.execute({
        sql: `
          SELECT name, COUNT(*) as count FROM transactions
          WHERE category = 'Uncategorized' AND ignored = 0
          GROUP BY name ORDER BY count DESC LIMIT ?
        `,
        args: [limit],
      });
      const rows = result.rows as unknown as { name: string; count: number }[];
      return rows.length
        ? rows.map((r) => `${String(r.count).padStart(4)}x  ${r.name}`).join('\n')
        : 'No uncategorized transactions.';
    }

    case 'get_finance_guide': {
      if (!input['topic']) {
        const topics = getFinanceTopicList();
        return ['Topics:', ...topics.map((t) => `  ${t.topic.padEnd(18)} ${t.title}: ${t.summary}`)].join('\n');
      }
      const section = getFinanceGuide(str('topic') as GuideTopic);
      return Array.isArray(section) ? section.map(formatGuideSection).join('\n\n---\n\n') : formatGuideSection(section);
    }

    case 'get_net_worth_history': {
      const granularity = (input['granularity'] ?? 'month') as NetWorthGranularity;
      const rows = await getNetWorthHistory(granularity);
      if (!rows.length) return 'No balance history available. Sync accounts first.';
      const header = `${'Period'.padEnd(12)}  ${'Assets'.padStart(14)}  ${'Liabilities'.padStart(14)}  ${'Net Worth'.padStart(14)}`;
      const divider = '─'.repeat(header.length);
      const lines = rows.map((r) =>
        `${r.period.padEnd(12)}  ${fmt(r.assets, 0).padStart(14)}  ${fmt(r.liabilities, 0).padStart(14)}  ${fmt(r.net_worth, 0).padStart(14)}`
      );
      return [header, divider, ...lines].join('\n');
    }

    // ── Calculator tools ──────────────────────────────────────────────────────

    case 'calculate_tvm': {
      const tvmInput = {
        pv:   input['pv']   !== undefined ? num('pv')   : undefined,
        fv:   input['fv']   !== undefined ? num('fv')   : undefined,
        pmt:  input['pmt']  !== undefined ? num('pmt')  : undefined,
        n:    input['n']    !== undefined ? num('n')    : undefined,
        rate: input['rate'] !== undefined ? num('rate') : undefined,
      };
      try {
        const r = solveTVM(tvmInput);
        const fmtVal = (v: number | undefined) => v === undefined ? '?' : v % 1 === 0 ? v.toString() : v.toFixed(6);
        const pctRate = r.rate !== undefined ? `${(r.rate * 100).toFixed(4)}%/period` : '?';
        return [
          `TVM Result — solved for: ${r.solved.toUpperCase()} = ${fmtVal(r.value)}`,
          `  PV:   ${fmtVal(r.pv)}`,
          `  FV:   ${fmtVal(r.fv)}`,
          `  PMT:  ${fmtVal(r.pmt)}`,
          `  N:    ${fmtVal(r.n)}`,
          `  Rate: ${pctRate}`,
        ].join('\n');
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    }

    // ── Write tools ───────────────────────────────────────────────────────────

    case 'edit_transaction': {
      const txResult = await db.execute({ sql: 'SELECT name FROM transactions WHERE id = ?', args: [str('id')] });
      const tx = txResult.rows[0] as unknown as { name: string } | undefined;
      if (!tx) return `No transaction with id ${str('id')}.`;
      await setTransactionCategory(str('id'), str('category'));
      return `Set "${tx.name}" → ${str('category')} (pinned)`;
    }

    case 'clear_edit': {
      const txResult = await db.execute({ sql: 'SELECT name FROM transactions WHERE id = ?', args: [str('id')] });
      const tx = txResult.rows[0] as unknown as { name: string } | undefined;
      if (!tx) return `No transaction with id ${str('id')}.`;
      await clearTransactionOverride(str('id'));
      const revertedResult = await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [str('id')] });
      const reverted = (revertedResult.rows[0] as unknown as { category: string }).category;
      return `Cleared override on "${tx.name}" — reverted to ${reverted}`;
    }

    case 'ignore_transaction': {
      const txResult = await db.execute({ sql: 'SELECT name FROM transactions WHERE id = ?', args: [str('id')] });
      const tx = txResult.rows[0] as unknown as { name: string } | undefined;
      if (!tx) return `No transaction with id ${str('id')}.`;
      await setTransactionIgnored(str('id'), bool('ignore'));
      return `"${tx.name}" ${bool('ignore') ? 'ignored' : 'un-ignored'}`;
    }

    case 'add_rule': {
      if (str('match_type') === 'regex') validateRegex(str('pattern'));
      await db.execute({
        sql: 'INSERT INTO category_rules (priority, match_type, pattern, category, min_amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)',
        args: [input['priority'] ? num('priority') : 10, str('match_type'), str('pattern'), str('category'), opt('min_amount'), opt('max_amount')],
      });
      const count = await applyCategoriesToAll();
      return `Rule added: "${str('pattern')}" → ${str('category')}\nRecategorized ${count} transactions.`;
    }

    case 'delete_rule': {
      const ruleResult = await db.execute({ sql: 'SELECT pattern, category FROM category_rules WHERE id = ?', args: [num('id')] });
      const rule = ruleResult.rows[0] as unknown as { pattern: string; category: string } | undefined;
      if (!rule) return `No rule with id ${num('id')}.`;
      await db.execute({ sql: 'DELETE FROM category_rules WHERE id = ?', args: [num('id')] });
      return `Deleted rule: "${rule.pattern}" → ${rule.category}`;
    }

    case 'add_name_rule': {
      if (str('match_type') === 'regex') validateRegex(str('pattern'));
      await db.execute({
        sql: 'INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount) VALUES (?, ?, ?, ?, ?)',
        args: [str('match_type'), str('pattern'), str('replacement'), opt('min_amount'), opt('max_amount')],
      });
      const count = await rebuildDisplayNames();
      return `Name rule added: "${str('pattern')}" → "${str('replacement')}"\nUpdated ${count} transactions.`;
    }

    case 'delete_name_rule': {
      const ruleResult = await db.execute({ sql: 'SELECT pattern, replacement FROM name_rules WHERE id = ?', args: [num('id')] });
      const rule = ruleResult.rows[0] as unknown as { pattern: string; replacement: string } | undefined;
      if (!rule) return `No name rule with id ${num('id')}.`;
      await db.execute({ sql: 'DELETE FROM name_rules WHERE id = ?', args: [num('id')] });
      return `Deleted name rule: "${rule.pattern}" → "${rule.replacement}"`;
    }

    case 'tag_transaction': {
      const txResult = await db.execute({ sql: 'SELECT name FROM transactions WHERE id = ?', args: [str('id')] });
      const tx = txResult.rows[0] as unknown as { name: string } | undefined;
      if (!tx) return `No transaction with id ${str('id')}.`;
      if (bool('add')) {
        const tagId = await getOrCreateTag(str('tag'));
        await addTagToTransaction(str('id'), tagId);
        return `Tagged "${tx.name}" with #${str('tag')}`;
      } else {
        const tagRowResult = await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [str('tag')] });
        const tagRow = tagRowResult.rows[0] as unknown as { id: number } | undefined;
        if (tagRow) await removeTagFromTransaction(str('id'), tagRow.id);
        return `Removed #${str('tag')} from "${tx.name}"`;
      }
    }

    case 'toggle_hidden_category': {
      if (bool('hide')) {
        await db.execute({ sql: 'INSERT OR IGNORE INTO hidden_categories (category) VALUES (?)', args: [str('category')] });
        return `"${str('category')}" is now hidden from totals.`;
      } else {
        await db.execute({ sql: 'DELETE FROM hidden_categories WHERE category = ?', args: [str('category')] });
        return `"${str('category')}" is now visible.`;
      }
    }

    case 'sync': {
      const results = await syncAll();
      const total = results.reduce((s, r) => s + r.added, 0);
      return results.map((r) => `${r.itemId}: +${r.added} added, ${r.modified} modified, ${r.removed} removed`).join('\n')
        + `\n\nTotal new transactions: ${total}`;
    }

    case 'get_screen': {
      const screenPath = join(DATA_DIR, 'screen.txt');
      try {
        return readFileSync(screenPath, 'utf-8');
      } catch {
        return 'Screen not available — TUI may not be running.';
      }
    }

    case 'show_canvas': {
      const specStr = str('spec');
      const spec = JSON.parse(specStr);
      const entry = appendHistory({ title: spec.title ?? 'Untitled', prompt: str('prompt'), spec });
      writeFileSync(CANVAS_SPEC_PATH, JSON.stringify({ ...spec, _historyId: entry.id, _writtenAt: Date.now() }), 'utf-8');
      return `Canvas "${entry.title}" rendered on screen 9 (id: ${entry.id}).`;
    }

    case 'list_canvases': {
      const results = searchHistory(str('search') || undefined);
      if (!results.length) return 'No canvases found.';
      return results.map((e) =>
        `${e.id}  ${e.title}\n  prompt: ${e.prompt}\n  created: ${e.createdAt.slice(0, 10)}`
      ).join('\n\n');
    }

    case 'load_canvas': {
      const entry = getHistoryEntry(str('id'));
      if (!entry) return `No canvas found with id "${str('id')}".`;
      writeFileSync(CANVAS_SPEC_PATH, JSON.stringify({ ...entry.spec, _historyId: entry.id, _writtenAt: Date.now() }), 'utf-8');
      return `Canvas "${entry.title}" loaded on screen 9.`;
    }

    case 'delete_canvas': {
      const deleted = deleteHistoryEntry(str('id'));
      return deleted ? `Canvas deleted.` : `No canvas found with id "${str('id')}".`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const result = await executeToolImpl(name, input);
  if (WRITE_TOOLS.has(name)) notifyChange();
  return result;
}
