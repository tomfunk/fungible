// Text-only chat over the sync server's LLM proxy — the real implementation behind
// the `agent:*` channels in agent-bridge.ts.
//
// What this is NOT (yet): core/agent.ts's actual tool-calling loop. That loop
// (core/tools.ts's 30+ tools — spending_summary, list_transactions,
// edit_transaction, the `show` UI-navigation tool, etc.) can't be imported
// into this bundle today: core/tools.ts itself has a top-level
// `import { readFileSync } from 'node:fs'` (used by exactly one tool,
// get_screen — a TUI-only concept) and imports core/sync.ts (Plaid + local
// crypto, for the `sync` tool) and core/canvas-history.ts (node:fs, for the
// 4 canvas tools) — none of which resolve in a browser bundle, and Vite must
// resolve a module's *entire* import graph, so those three imports block the
// whole file even though the other ~27 tools are pure data functions already
// bundled and callable via core-bridge.ts today (queries/transactions/tags/
// rules/health/trends/accounts). Until core splits those 6 desktop/TUI-only
// tools out of tools.ts (the same way accounts.ts was split from csv.ts for
// the browser build), there's no bundlable TOOL_DEFS/executeTool to reuse
// here, and duplicating 27 tool definitions + their descriptions by hand
// would drift from core's copy the first time either one changes — so this
// file only does the streaming LLM round trip and plain conversation.
//
// So: this is a real, working chat (no stub, no fake data) that can discuss
// finance in general and anything the user types in-thread, but it cannot
// look up or change the user's actual transactions/balances/rules, and it
// never navigates the UI. ChatDrawer.tsx's confirm/tool/navigate events
// (agent:tool, agent:confirm, agent:navigate) are simply never emitted here.

import { APP_CONTEXT } from '../../core/agent-context.js';
import { llmRequest, LlmProxyError, isConnected, type LlmProvider } from './account-client.js';

// Defaults copied from core/llm-provider.ts's getProviderModel() fallbacks
// (ANTHROPIC_MODEL / OPENAI_MODEL env vars are operator-side
// config here, not something this client can read) — keep in sync with that
// file if the defaults there change.
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = 'gpt-5.4-nano';

const SYSTEM_PROMPT = `You are a personal finance assistant embedded in fungible, a personal finance app.

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

## Behavior
- Be concise. When you don't have enough information about the user's actual accounts or
  transactions to answer precisely, say so plainly and answer in general terms instead of guessing.
- IMPORTANT: on this build, you cannot look up the user's real transactions, balances, or
  accounts, and you cannot navigate the app or make any changes — that capability isn't wired up
  yet. Don't claim to have checked their data; only use numbers they've typed into the chat
  themselves.`.trim();

type ChatMessage = { role: 'user' | 'assistant'; content: string };

let chatHistory: ChatMessage[] = [];
let inflight = false;

export function resetChat(): void {
  if (inflight) return; // mirrors gui/main/agent-ipc.ts: don't clear mid-turn
  chatHistory = [];
}

// ─── Provider detection ─────────────────────────────────────────────────────
// the sync server has no "which key is configured" status endpoint, so the only way
// to know is a real (minimal) call. Cache a successful result for the tab's
// lifetime; don't cache a failure, so a transient network blip doesn't
// permanently disable the input.

type ProviderInfo = { provider: LlmProvider; model: string };

let cachedInfo: ProviderInfo | null = null;
let cachedInfoPromise: Promise<ProviderInfo | null> | null = null;

async function probe(provider: LlmProvider, model: string): Promise<ProviderInfo | null> {
  try {
    // Anthropic's Messages API requires max_tokens; OpenAI's chat completions
    // API doesn't take it here (newer model families use max_completion_tokens
    // instead, and core/llm-provider.ts's real streamOpenAI() doesn't set
    // either) — left unset for the OpenAI probe rather than guessing which
    // param name this model generation wants.
    const res = await llmRequest(
      provider,
      provider === 'anthropic'
        ? { model, max_tokens: 1, system: 'ping', messages: [{ role: 'user', content: 'hi' }] }
        : { model, messages: [{ role: 'system', content: 'ping' }, { role: 'user', content: 'hi' }] },
    );
    const json = (await res.json()) as { model?: string };
    return { provider, model: json.model ?? model };
  } catch (e) {
    if (e instanceof LlmProxyError && e.code === `${provider}_not_configured`) return null;
    throw e; // a real problem (cap exceeded, paid tier required, network) — don't mask it as "not configured"
  }
}

async function detect(): Promise<ProviderInfo | null> {
  // Local-only: there is no server to ask, and no request is made until the
  // user connects (the failure is not cached, so detection runs again then).
  if (!(await isConnected())) return null;
  try {
    return (await probe('anthropic', ANTHROPIC_MODEL)) ?? (await probe('openai', OPENAI_MODEL));
  } catch (e) {
    console.error('agent-llm: provider detection failed', e);
    return null;
  }
}

/** Resolves to "provider/model" once the sync server has a working LLM key, or null
 *  if neither is configured / detection failed. Never throws. */
export async function getProviderLabel(): Promise<string | null> {
  const info = await getProviderInfo();
  return info ? `${info.provider}/${info.model}` : null;
}

async function getProviderInfo(): Promise<ProviderInfo | null> {
  if (cachedInfo) return cachedInfo;
  if (!cachedInfoPromise) {
    cachedInfoPromise = detect().then((info) => {
      cachedInfoPromise = null;
      if (info) cachedInfo = info;
      return info;
    });
  }
  return cachedInfoPromise;
}

// ─── SSE parsing ────────────────────────────────────────────────────────────

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) yield { event, data: dataLines.join('\n') };
    }
  }
}

async function streamAnthropic(model: string, messages: ChatMessage[], onText: (delta: string) => void): Promise<string> {
  const res = await llmRequest('anthropic', {
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
    stream: true,
  });
  let text = '';
  for await (const { data } of sseEvents(res.body!)) {
    if (data === '[DONE]') break;
    let evt: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
    try { evt = JSON.parse(data); } catch { continue; }
    if (evt.type === 'error') throw new Error(evt.error?.message ?? 'Anthropic stream error');
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
      text += evt.delta.text;
      onText(evt.delta.text);
    }
  }
  return text;
}

async function streamOpenAI(model: string, messages: ChatMessage[], onText: (delta: string) => void): Promise<string> {
  const res = await llmRequest('openai', {
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    stream: true,
  });
  let text = '';
  for await (const { data } of sseEvents(res.body!)) {
    if (data === '[DONE]') break;
    let chunk: { choices?: { delta?: { content?: string } }[] };
    try { chunk = JSON.parse(data); } catch { continue; }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      onText(delta);
    }
  }
  return text;
}

// ─── Turn ────────────────────────────────────────────────────────────────────

export async function runChatTurn(userMessage: string, onText: (delta: string) => void): Promise<void> {
  if (inflight) throw new Error('The agent is already responding — wait for the current turn to finish');
  inflight = true;
  const historyLenBefore = chatHistory.length;
  chatHistory.push({ role: 'user', content: userMessage });
  try {
    const info = await getProviderInfo();
    if (!info) throw new Error('No LLM provider is configured on the server (the sync server has neither ANTHROPIC_API_KEY nor OPENAI_API_KEY set).');
    const reply =
      info.provider === 'anthropic'
        ? await streamAnthropic(info.model, chatHistory, onText)
        : await streamOpenAI(info.model, chatHistory, onText);
    if (reply) chatHistory.push({ role: 'assistant', content: reply });
  } catch (e) {
    chatHistory.splice(historyLenBefore); // roll back the partial turn, same as desktop's agent-ipc.ts
    if (e instanceof LlmProxyError) {
      if (e.code === 'usage_cap_exceeded') throw new Error('Usage cap reached for this billing period — try again later.');
      if (e.code === 'paid_tier_required') throw new Error('This account needs the paid tier to use the assistant.');
      // Anything else with this shape is a raw upstream error the sync server forwarded as-is
      // (e.g. OpenAI's own 'insufficient_quota' when the operator's key is out of
      // credit, or 'rate_limit_exceeded') — e.message already names the status + code,
      // which is more useful here than inventing a generic wrapper string.
    }
    throw e;
  } finally {
    inflight = false;
  }
}
