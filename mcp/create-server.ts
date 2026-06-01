import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeTool, WRITE_TOOLS } from '../core/tools.js';

export function createMcpServer(opts: { afterWrite?: () => void } = {}): McpServer {
  async function run(name: string, input: Record<string, unknown>) {
    const text = await executeTool(name, input);
    if (opts.afterWrite && WRITE_TOOLS.has(name)) opts.afterWrite();
    return { content: [{ type: 'text' as const, text }] };
  }
  const server = new McpServer({ name: 'fungible', version: '1.0.0' });

  // ── spending_summary ────────────────────────────────────────────────────────

  server.tool(
    'spending_summary',
    'Get income, expenses, net, and spending by category. Provide either (year + month) for a specific month, or (from + to) for an arbitrary date range.',
    {
      year:  z.number().int().optional().describe('4-digit year, e.g. 2026'),
      month: z.number().int().min(1).max(12).optional().describe('Month number 1–12'),
      from:  z.string().optional().describe('Start date YYYY-MM-DD (use with to)'),
      to:    z.string().optional().describe('End date YYYY-MM-DD (use with from)'),
    },
    (input) => run('spending_summary', input),
  );

  // ── merchant_summary ────────────────────────────────────────────────────────

  server.tool(
    'merchant_summary',
    'Get top merchants for a category in a date range, with total amount, transaction count, and share of category spend.',
    {
      category: z.string().describe('Category name, e.g. "Food & Drink"'),
      year:     z.number().int().optional().describe('4-digit year (use with month)'),
      month:    z.number().int().min(1).max(12).optional().describe('Month 1–12 (use with year)'),
      from:     z.string().optional().describe('Start date YYYY-MM-DD (use with to)'),
      to:       z.string().optional().describe('End date YYYY-MM-DD (use with from)'),
    },
    (input) => run('merchant_summary', input),
  );

  // ── list_transactions ───────────────────────────────────────────────────────

  server.tool(
    'list_transactions',
    'List transactions with optional filters. Returns date, name, amount, category, account. Ignored transactions are marked.',
    {
      category:        z.string().optional().describe('Filter by category name'),
      month:           z.number().int().min(1).max(12).optional().describe('Month 1–12 (use with year)'),
      year:            z.number().int().optional().describe('4-digit year (use with month)'),
      from:            z.string().optional().describe('Start date YYYY-MM-DD (use with to)'),
      to:              z.string().optional().describe('End date YYYY-MM-DD (use with from)'),
      search:          z.string().optional().describe('Search within name or display name'),
      include_ignored: z.boolean().default(false).describe('Include ignored transactions (default false)'),
      limit:           z.number().int().min(1).max(500).default(50).describe('Max results (default 50)'),
    },
    (input) => run('list_transactions', input),
  );

  // ── edit_transaction ────────────────────────────────────────────────────────

  server.tool(
    'edit_transaction',
    'Manually set the category for a specific transaction (pins it — survives syncs). Use list_transactions to get the ID.',
    {
      id:       z.string().describe('Transaction ID from list_transactions'),
      category: z.string().describe('Category to assign'),
    },
    (input) => run('edit_transaction', input),
  );

  // ── clear_edit ──────────────────────────────────────────────────────────────

  server.tool(
    'clear_edit',
    'Remove a manual category override from a transaction, reverting it to rule-based categorization.',
    {
      id: z.string().describe('Transaction ID from list_transactions'),
    },
    (input) => run('clear_edit', input),
  );

  // ── ignore_transaction ──────────────────────────────────────────────────────

  server.tool(
    'ignore_transaction',
    'Toggle the ignored flag on a transaction. Ignored transactions are hidden from totals and charts.',
    {
      id:     z.string().describe('Transaction ID from list_transactions'),
      ignore: z.boolean().describe('true to ignore, false to un-ignore'),
    },
    (input) => run('ignore_transaction', input),
  );

  // ── list_rules ──────────────────────────────────────────────────────────────

  server.tool(
    'list_rules',
    'List all category rules.',
    {},
    () => run('list_rules', {}),
  );

  // ── add_rule ────────────────────────────────────────────────────────────────

  server.tool(
    'add_rule',
    'Add a category rule and immediately apply it to all non-manually-categorized transactions.',
    {
      pattern:    z.string().describe('Text to match against transaction name'),
      match_type: z.enum(['name', 'regex']).describe('"name" for substring match, "regex" for regex'),
      category:   z.string().describe('Category to assign, e.g. "Food & Drink"'),
      priority:   z.number().int().default(10).describe('Higher priority rules run first (default 10)'),
      min_amount: z.number().optional().describe('Minimum transaction amount (optional)'),
      max_amount: z.number().optional().describe('Maximum transaction amount (optional)'),
    },
    (input) => run('add_rule', input),
  );

  // ── delete_rule ─────────────────────────────────────────────────────────────

  server.tool(
    'delete_rule',
    'Delete a category rule by ID. Use list_rules to find the ID.',
    {
      id: z.number().int().describe('Rule ID from list_rules'),
    },
    (input) => run('delete_rule', input),
  );

  // ── list_name_rules ─────────────────────────────────────────────────────────

  server.tool(
    'list_name_rules',
    'List all name rules (rules that rename transaction display names).',
    {},
    () => run('list_name_rules', {}),
  );

  // ── add_name_rule ───────────────────────────────────────────────────────────

  server.tool(
    'add_name_rule',
    'Add a name rule that renames how transactions are displayed (does not affect rule matching).',
    {
      pattern:     z.string().describe('Text or regex to match against transaction name'),
      match_type:  z.enum(['name', 'regex']).describe('"name" for substring match, "regex" for regex'),
      replacement: z.string().describe('Display name to show instead'),
      min_amount:  z.number().optional().describe('Minimum transaction amount (optional)'),
      max_amount:  z.number().optional().describe('Maximum transaction amount (optional)'),
    },
    (input) => run('add_name_rule', input),
  );

  // ── delete_name_rule ────────────────────────────────────────────────────────

  server.tool(
    'delete_name_rule',
    'Delete a name rule by ID. Use list_name_rules to find the ID.',
    {
      id: z.number().int().describe('Name rule ID from list_name_rules'),
    },
    (input) => run('delete_name_rule', input),
  );

  // ── list_hidden_categories ──────────────────────────────────────────────────

  server.tool(
    'list_hidden_categories',
    'List categories hidden from totals and charts (e.g. Transfer, Loan Payment).',
    {},
    () => run('list_hidden_categories', {}),
  );

  // ── toggle_hidden_category ──────────────────────────────────────────────────

  server.tool(
    'toggle_hidden_category',
    'Add or remove a category from the hidden list. Hidden categories are excluded from expense totals and charts.',
    {
      category: z.string().describe('Category name, e.g. "Transfer"'),
      hide:     z.boolean().describe('true to hide, false to unhide'),
    },
    (input) => run('toggle_hidden_category', input),
  );

  // ── list_accounts ───────────────────────────────────────────────────────────

  server.tool(
    'list_accounts',
    'List all connected bank accounts.',
    {},
    () => run('list_accounts', {}),
  );

  // ── sync ────────────────────────────────────────────────────────────────────

  server.tool(
    'sync',
    'Sync latest transactions from Plaid for all connected accounts.',
    {},
    () => run('sync', {}),
  );

  // ── uncategorized_summary ───────────────────────────────────────────────────

  server.tool(
    'uncategorized_summary',
    'Show the most common uncategorized transaction names to help write new rules.',
    {
      limit: z.number().int().min(1).max(100).default(30),
    },
    (input) => run('uncategorized_summary', input),
  );

  // ── list_tags ───────────────────────────────────────────────────────────────

  server.tool(
    'list_tags',
    'List all tags with transaction counts.',
    {},
    () => run('list_tags', {}),
  );

  // ── tag_summary ─────────────────────────────────────────────────────────────

  server.tool(
    'tag_summary',
    'Get income, expenses, net, and spending by category for all transactions tagged with a given tag.',
    {
      tag: z.string().describe('Tag name'),
    },
    (input) => run('tag_summary', input),
  );

  // ── tag_transaction ─────────────────────────────────────────────────────────

  server.tool(
    'tag_transaction',
    'Add or remove a tag on a transaction. Creates the tag if it does not exist.',
    {
      id:  z.string().describe('Transaction ID from list_transactions'),
      tag: z.string().describe('Tag name'),
      add: z.boolean().describe('true to add the tag, false to remove it'),
    },
    (input) => run('tag_transaction', input),
  );

  // ── get_balances ────────────────────────────────────────────────────────────

  server.tool(
    'get_balances',
    'Get current balances for all accounts, plus net worth, total cash (depository), and total liquid (depository + brokerage) amounts.',
    {},
    () => run('get_balances', {}),
  );

  // ── get_financial_health ────────────────────────────────────────────────────

  server.tool(
    'get_financial_health',
    'Get financial health metrics: cash and liquid runway, FIRE number and progress, estimated years to retirement.',
    {
      withdrawal_rate: z.number().min(0.5).max(10).default(4).describe('Safe withdrawal rate % (default 4)'),
      growth_rate:     z.number().min(0).max(20).default(7).describe('Expected annual growth rate % (default 7)'),
    },
    (input) => run('get_financial_health', input),
  );

  // ── get_drift ───────────────────────────────────────────────────────────────

  server.tool(
    'get_drift',
    'Show spending deltas per category: current amount vs prior period, same period last year, and 12-month rolling average. Defaults to current month-to-date.',
    {
      year:  z.number().int().optional().describe('4-digit year (default: current year)'),
      month: z.number().int().min(1).max(12).optional().describe('Month 1–12 (default: current month)'),
      day:   z.number().int().min(1).max(31).optional().describe('Day through which to compare (default: today)'),
    },
    (input) => run('get_drift', input),
  );

  // ── get_trends ──────────────────────────────────────────────────────────────

  server.tool(
    'get_trends',
    'Get month-by-month spending trends for the last N months. Optionally filter to a specific category.',
    {
      months:   z.number().int().min(1).max(60).default(12).describe('Number of months to look back (default 12)'),
      category: z.string().optional().describe('Category name to track (optional; omit for overall)'),
    },
    (input) => run('get_trends', input),
  );

  // ── get_finance_guide ───────────────────────────────────────────────────────

  server.tool(
    'get_finance_guide',
    'Get opinionated personal finance guidance. Call without a topic for an overview of all topics; call with a topic for detailed advice on that area.',
    {
      topic: z.enum([
        'priorities', 'emergency-fund', 'debt', 'employer-match',
        'hsa', 'ira', '401k', 'investing', 'budgeting', 'fire',
        'housing', 'car', 'insurance',
      ]).optional().describe('Specific topic (omit for topic list overview)'),
    },
    (input) => run('get_finance_guide', input),
  );

  // ── get_net_worth_history ───────────────────────────────────────────────────

  server.tool(
    'get_net_worth_history',
    'Net worth over time grouped by day, week, month, quarter, or year.',
    {
      granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('month').describe('Time grouping (default: month)'),
    },
    (input) => run('get_net_worth_history', input),
  );

  // ── calculate_tvm ───────────────────────────────────────────────────────────

  server.tool(
    'calculate_tvm',
    'Time Value of Money solver. Provide any 4 of the 5 variables (pv, fv, pmt, n, rate) and it solves for the missing one. Rate is the periodic rate in decimal (e.g. 0.005 for 0.5%/mo). Sign convention: outflows negative, inflows positive.',
    {
      pv:   z.number().optional().describe('Present value — positive if cash received, negative if paid out'),
      fv:   z.number().optional().describe('Future value — positive if cash received, negative if paid out'),
      pmt:  z.number().optional().describe('Periodic payment — negative if paying, positive if receiving'),
      n:    z.number().optional().describe('Number of periods'),
      rate: z.number().optional().describe('Rate per period in decimal (e.g. 0.005 = 0.5%/period)'),
    },
    (input) => run('calculate_tvm', input),
  );

  return server;
}
