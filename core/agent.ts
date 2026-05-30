/**
 * Agent core — runs the agentic loop using the detected LLM provider.
 * Tool implementations live in core/tools.ts (shared with mcp/server.ts).
 */

import 'dotenv/config';
import { streamResponse, makeAssistantMessage, detectProvider, getProviderModel } from './llm-provider.js';
import type { Message, ContentBlock, ToolDef } from './llm-provider.js';
import { APP_CONTEXT } from './agent-context.js';
import { TOOL_DEFS, WRITE_TOOLS, describeToolCall, executeTool } from './tools.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentCallbacks = {
  /** Called for each streaming text chunk. */
  onText: (delta: string) => void;
  /** Called when the agent starts executing a tool. */
  onToolCall: (name: string, humanDesc: string) => void;
  /** Called when a write tool needs confirmation. Resolves true = proceed. */
  onConfirm: (humanDesc: string) => Promise<boolean>;
  /** Called by the `show` tool to navigate the UI. */
  onNavigate: (screen: string, filter?: Record<string, string>) => void;
};

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const provider = (() => { try { return detectProvider(); } catch { return 'unknown'; } })();
  const model    = (() => { try { return getProviderModel(provider as 'anthropic' | 'openai'); } catch { return ''; } })();

  return `You are a personal finance assistant embedded in fungible, a terminal-based personal finance app.
You run inside the app itself — you can read the user's financial data, take actions on their behalf (with confirmation), and navigate the app UI to show them relevant views.

${APP_CONTEXT}

## Personal Finance Philosophy

Follow this priority waterfall — do steps in order:
1. Employer 401k match — always capture the full match first (it's a guaranteed 50–100% return)
2. High-interest debt (>6–7%) — eliminate before investing; guaranteed return beats the market
3. Emergency fund (3–6 months expenses) — HYSA only, not invested
4. HSA — triple tax advantage if you have an HDHP; max it and invest the balance
5. IRA — Roth if income allows ($7k/yr limit); Traditional or Backdoor Roth otherwise
6. 401k beyond match — max it ($23k/yr limit); pick lowest-expense index funds
7. Medium-interest debt (3–6%) — judgment call vs investing
8. Taxable investing — total-market index funds, low cost
9. Low-interest debt (<3%) — mathematically better to invest; pay if it bothers you

Use \`get_finance_guide\` for detailed guidance on any topic.

## Behavior
- Proactively fetch relevant data before answering financial questions — don't answer blind
- Use the \`show\` tool to navigate the app to the most relevant screen when it helps understanding
- Be concise. Use numbers from actual data rather than generalities.
- For write operations, be specific about exactly what will change before asking confirmation
- When the user asks about their situation, compare it to the priority waterfall and give actionable advice

Model in use: ${model}
`.trim();
}

// ─── Agent-only tool: `show` ──────────────────────────────────────────────────

const SHOW_TOOL: ToolDef = {
  name: 'show',
  description: 'Navigate the app UI to display a specific screen or filtered view. Use this to show the user relevant data visually.',
  parameters: {
    type: 'object',
    properties: {
      screen:      { type: 'string', description: 'Screen to navigate to', enum: ['dashboard', 'transactions', 'trends', 'networth', 'tags', 'rules', 'accounts', 'health'] },
      category:    { type: 'string', description: 'Filter transactions by category' },
      from:        { type: 'string', description: 'Start date YYYY-MM-DD' },
      to:          { type: 'string', description: 'End date YYYY-MM-DD' },
      tag:         { type: 'string', description: 'Filter by tag' },
      account:     { type: 'string', description: 'Filter by account ID' },
      accountName: { type: 'string', description: 'Account display name (paired with account)' },
      search:      { type: 'string', description: 'Pre-fill the search box on the transactions screen (regex)' },
      range:       { type: 'string', description: 'Time range to show on dashboard or trends', enum: ['week', 'month', 'quarter', 'year', 'alltime'] },
      anchor:      { type: 'string', description: 'Which period to land on — any date within it, YYYY-MM-DD (e.g. "2026-03-01" for March 2026)' },
    },
    required: ['screen'],
  },
};

const AGENT_TOOL_DEFS: ToolDef[] = [...TOOL_DEFS, SHOW_TOOL];

// ─── Tool dispatch (agent layer: show + confirmation wrapper) ──────────────────

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  callbacks: AgentCallbacks,
): Promise<string> {
  // UI navigation — agent-only, no confirmation
  if (name === 'show') {
    const { screen, ...rest } = input as Record<string, string>;
    const filter: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) filter[k] = String(v);
    }
    callbacks.onNavigate(screen, filter);
    const desc = Object.keys(filter).length
      ? `${screen} (${Object.entries(filter).map(([k, v]) => `${k}: ${v}`).join(', ')})`
      : screen;
    return `Navigated to ${desc}`;
  }

  // Write tools — confirm before executing
  if (WRITE_TOOLS.has(name)) {
    const confirmed = await callbacks.onConfirm(describeToolCall(name, input));
    if (!confirmed) return 'Cancelled.';
  }

  return executeTool(name, input);
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

/**
 * Run one user turn through the agent loop.
 * Mutates `history` in place (appends messages).
 * Streams text via callbacks; pauses for confirmation on write tools.
 */
export async function runAgentTurn(
  userMessage: string,
  history: Message[],
  callbacks: AgentCallbacks,
): Promise<void> {
  history.push({ role: 'user', content: userMessage });

  const system = buildSystemPrompt();

  while (true) {
    const currentBlocks: ContentBlock[] = [];
    let   currentText = '';

    for await (const chunk of streamResponse(system, history, AGENT_TOOL_DEFS)) {
      if (chunk.type === 'text') {
        currentText += chunk.delta;
        callbacks.onText(chunk.delta);
      } else if (chunk.type === 'tool_use') {
        if (chunk.name !== 'show') {
          callbacks.onToolCall(chunk.name, describeToolCall(chunk.name, chunk.input));
        }
        currentBlocks.push({ type: 'tool_use', id: chunk.id, name: chunk.name, input: chunk.input });
      }
    }

    if (currentText) currentBlocks.unshift({ type: 'text', text: currentText });
    history.push(makeAssistantMessage(currentBlocks));

    const toolCalls = currentBlocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!toolCalls.length) break;

    for (const call of toolCalls) {
      let result: string;
      try {
        result = await dispatchTool(call.name, call.input as Record<string, unknown>, callbacks);
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      history.push({ role: 'tool_result', tool_use_id: call.id, content: result });
    }
  }
}
