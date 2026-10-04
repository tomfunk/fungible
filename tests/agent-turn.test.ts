import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message, StreamChunk } from '../core/llm-provider.js';

// Only the provider stream and the tool layer are stubbed; the loop, the
// confirmation gate, `show` handling and error wrapping in core/agent.ts are real.
vi.mock('../core/llm-provider.js', async (orig) => {
  const actual = await orig<typeof import('../core/llm-provider.js')>();
  return { ...actual, streamResponse: vi.fn(), detectProvider: () => 'anthropic', getProviderModel: () => 'test-model' };
});
vi.mock('../core/tools.js', () => ({
  TOOL_DEFS: [],
  WRITE_TOOLS: new Set(['add_rule']),
  describeToolCall: (name: string) => `call ${name}`,
  describeToolCallDetailed: async (name: string, input: unknown) => `detailed ${name} ${JSON.stringify(input)}`,
  executeTool: vi.fn(),
}));
vi.mock('../core/canvas-history.js', () => ({
  buildCanvasContextSections: vi.fn(async () => ['CTX-A', 'CTX-B']),
}));

import { streamResponse } from '../core/llm-provider.js';
import { executeTool } from '../core/tools.js';
import { runAgentTurn, MAX_AGENT_ITERATIONS, type AgentCallbacks } from '../core/agent.js';

/** Script streamResponse: one array of chunks per call. */
function script(...turns: StreamChunk[][]) {
  let i = 0;
  vi.mocked(streamResponse).mockImplementation((async function* () {
    const t = turns[Math.min(i++, turns.length - 1)];
    for (const c of t) yield c;
  }) as never);
}
const text = (delta: string): StreamChunk => ({ type: 'text', delta });
const tool = (id: string, name: string, input: Record<string, unknown> = {}): StreamChunk => ({ type: 'tool_use', id, name, input });

function makeCallbacks(confirm = true) {
  return {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onConfirm: vi.fn(async () => confirm),
    onNavigate: vi.fn(),
  } satisfies AgentCallbacks;
}

beforeEach(() => {
  vi.mocked(streamResponse).mockReset();
  vi.mocked(executeTool).mockReset();
  vi.mocked(executeTool).mockResolvedValue('tool-output');
});

describe('runAgentTurn', () => {
  it('plain text turn streams deltas in order and records [user, assistant]', async () => {
    script([text('Hel'), text('lo'), { type: 'done' }]);
    const cb = makeCallbacks();
    const history: Message[] = [];
    await runAgentTurn('hi', history, cb);

    expect(cb.onText.mock.calls.map((c) => c[0])).toEqual(['Hel', 'lo']);
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    ]);
    expect(streamResponse).toHaveBeenCalledTimes(1);
  });

  it('read tool: executes, pushes tool_result with the id, streams again and ends on text', async () => {
    script([text('checking'), tool('t1', 'list_accounts', { a: 1 })], [text('done')]);
    const cb = makeCallbacks();
    const history: Message[] = [];
    await runAgentTurn('q', history, cb);

    expect(executeTool).toHaveBeenCalledWith('list_accounts', { a: 1 });
    expect(streamResponse).toHaveBeenCalledTimes(2);
    expect(cb.onConfirm).not.toHaveBeenCalled();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(history[2]).toEqual({ role: 'tool_result', tool_use_id: 't1', content: 'tool-output' });
    expect(history[1]).toMatchObject({ content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1' }] });
  });

  it('write tool declined: not executed, result is Cancelled.', async () => {
    script([tool('w1', 'add_rule', { p: 'x' })], [text('ok')]);
    const cb = makeCallbacks(false);
    const history: Message[] = [];
    await runAgentTurn('q', history, cb);

    expect(cb.onConfirm).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(history[2]).toEqual({ role: 'tool_result', tool_use_id: 'w1', content: 'Cancelled.' });
  });

  it('write tool accepted: executed after onConfirm got the detailed description', async () => {
    script([tool('w1', 'add_rule', { p: 'x' })], [text('ok')]);
    const cb = makeCallbacks(true);
    const history: Message[] = [];
    await runAgentTurn('q', history, cb);

    expect(cb.onConfirm).toHaveBeenCalledWith('detailed add_rule {"p":"x"}');
    expect(executeTool).toHaveBeenCalledWith('add_rule', { p: 'x' });
    expect(history[2]).toMatchObject({ content: 'tool-output' });
  });

  it('show: navigates with stringified filter values, carries canvasSpec, no confirm, no onToolCall', async () => {
    script([tool('s1', 'show', { screen: 'transactions', category: 'Food', limit: 5, flag: false, canvasSpec: '{"a":1}', gone: undefined, nul: null })], [text('ok')]);
    const cb = makeCallbacks();
    const history: Message[] = [];
    await runAgentTurn('q', history, cb);

    expect(cb.onNavigate).toHaveBeenCalledTimes(1);
    expect(cb.onNavigate).toHaveBeenCalledWith('transactions', { category: 'Food', limit: '5', flag: 'false', canvasSpec: '{"a":1}' });
    expect(cb.onConfirm).not.toHaveBeenCalled();
    expect(cb.onToolCall).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(history[2]).toEqual({ role: 'tool_result', tool_use_id: 's1', content: 'Navigated to transactions' });
  });

  it('onToolCall fires for non-show tools with the human description', async () => {
    script([tool('t1', 'list_accounts')], [text('ok')]);
    const cb = makeCallbacks();
    await runAgentTurn('q', [], cb);
    expect(cb.onToolCall).toHaveBeenCalledWith('list_accounts', 'call list_accounts');
  });

  it('a throwing tool becomes "Error: msg" and the loop continues', async () => {
    vi.mocked(executeTool).mockRejectedValueOnce(new Error('boom'));
    script([tool('t1', 'list_accounts')], [text('recovered')]);
    const history: Message[] = [];
    await expect(runAgentTurn('q', history, makeCallbacks())).resolves.toBeUndefined();

    expect(history[2]).toEqual({ role: 'tool_result', tool_use_id: 't1', content: 'Error: boom' });
    expect(history[3]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] });
  });

  it('a non-Error throw is stringified', async () => {
    vi.mocked(executeTool).mockRejectedValueOnce('plain');
    script([tool('t1', 'list_accounts')], [text('x')]);
    const history: Message[] = [];
    await runAgentTurn('q', history, makeCallbacks());
    expect(history[2]).toMatchObject({ content: 'Error: plain' });
  });

  it('generate_canvas returns the context sections plus an instruction with the JSON-encoded prompt', async () => {
    script([tool('g1', 'generate_canvas', { prompt: 'what if "I" retire' })], [text('x')]);
    const history: Message[] = [];
    await runAgentTurn('q', history, makeCallbacks());

    const result = (history[2] as { content: string }).content;
    expect(result).toContain('CTX-A\n\nCTX-B');
    expect(result).toContain(`prompt: ${JSON.stringify('what if "I" retire')}`);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('multiple tool calls in one turn each get a tool_result in order', async () => {
    script([tool('a', 'list_accounts'), tool('b', 'list_tags')], [text('x')]);
    const history: Message[] = [];
    await runAgentTurn('q', history, makeCallbacks());
    expect(history.filter((m) => m.role === 'tool_result').map((m) => (m as { tool_use_id: string }).tool_use_id)).toEqual(['a', 'b']);
  });

  it('stops a runaway tool loop after MAX_AGENT_ITERATIONS and tells the user', async () => {
    let calls = 0;
    vi.mocked(streamResponse).mockImplementation((async function* () {
      calls++;
      yield tool(`l${calls}`, 'list_accounts');
    }) as never);
    vi.mocked(executeTool).mockResolvedValue('ok' as never);
    const cb = makeCallbacks();
    const history: Message[] = [];
    await runAgentTurn('q', history, cb);
    expect(calls).toBe(MAX_AGENT_ITERATIONS);
    expect(cb.onText).toHaveBeenCalledWith(expect.stringContaining('Stopped after'));
    expect(history.at(-1)).toMatchObject({ role: 'assistant' });
  });
});
