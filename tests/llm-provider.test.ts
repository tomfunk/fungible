import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  anthropicStream, anthropicText, anthropicToolUse, anthropicToolUseRaw, interleave,
  openaiStream, openaiText, openaiToolCall, openaiFinish,
} from './helpers/makeLlmStream.js';

const sdk = vi.hoisted(() => ({
  anthropicStream: vi.fn(),
  openaiStream: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { stream: sdk.anthropicStream }; },
}));
vi.mock('openai', () => ({
  default: class { chat = { completions: { stream: sdk.openaiStream } }; },
}));

import {
  detectProvider, getProviderModel, streamResponse, makeAssistantMessage,
  type Message, type StreamChunk, type ToolDef,
} from '../core/llm-provider.js';

const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_MODEL'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  sdk.anthropicStream.mockReset();
  sdk.openaiStream.mockReset();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function collect(system: string, messages: Message[], tools: ToolDef[] = []): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of streamResponse(system, messages, tools)) out.push(c);
  return out;
}

const tool: ToolDef = { name: 'list_tags', description: 'List tags', parameters: { type: 'object', properties: {} } };

describe('detectProvider / getProviderModel', () => {
  it('prefers Anthropic when both keys are set', () => {
    process.env.ANTHROPIC_API_KEY = 'a'; process.env.OPENAI_API_KEY = 'o';
    expect(detectProvider()).toBe('anthropic');
  });
  it('falls back to OpenAI when only its key is set', () => {
    process.env.OPENAI_API_KEY = 'o';
    expect(detectProvider()).toBe('openai');
  });
  it('errors naming both env vars when neither is set', () => {
    expect(() => detectProvider()).toThrow(/ANTHROPIC_API_KEY.*OPENAI_API_KEY/);
  });
  it('honours model env overrides and otherwise returns a non-empty default', () => {
    expect(getProviderModel('anthropic')).toBeTruthy();
    expect(getProviderModel('openai')).toBeTruthy();
    process.env.ANTHROPIC_MODEL = 'claude-x'; process.env.OPENAI_MODEL = 'gpt-x';
    expect(getProviderModel('anthropic')).toBe('claude-x');
    expect(getProviderModel('openai')).toBe('gpt-x');
  });
  it('streamResponse throws without a key', async () => {
    await expect(collect('s', [])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
  it('makeAssistantMessage wraps blocks', () => {
    expect(makeAssistantMessage([{ type: 'text', text: 'hi' }])).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] });
  });
});

describe('Anthropic provider', () => {
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'k'; });
  const run = async (events: Record<string, unknown>[], messages: Message[] = [{ role: 'user', content: 'hi' }], tools: ToolDef[] = []) => {
    sdk.anthropicStream.mockReturnValue(anthropicStream(events));
    const chunks = await collect('SYS', messages, tools);
    return { chunks, req: sdk.anthropicStream.mock.calls[0][0] };
  };

  it('request mapping: system is a separate param, folds consecutive tool_results into ONE user message, empty tools -> undefined', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'ignored-in-history' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'u1', name: 'a', input: { x: 1 } },
        { type: 'tool_use', id: 'u2', name: 'b', input: {} },
      ] },
      { role: 'tool_result', tool_use_id: 'u1', content: 'r1' },
      { role: 'tool_result', tool_use_id: 'u2', content: 'r2' },
    ];
    const { req } = await run([], messages);
    expect(req.system).toBe('SYS');
    expect(req.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(req.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'u1', content: 'r1' },
      { type: 'tool_result', tool_use_id: 'u2', content: 'r2' },
    ]);
    expect(req.tools).toBeUndefined();
  });

  it('maps tool definitions to input_schema', async () => {
    const { req } = await run([], undefined, [tool]);
    expect(req.tools).toEqual([{ name: 'list_tags', description: 'List tags', input_schema: tool.parameters }]);
  });

  it('streams text deltas then done', async () => {
    const { chunks } = await run(anthropicText(0, 'Hel', 'lo'));
    expect(chunks).toEqual([{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }, { type: 'done' }]);
  });

  it('assembles a tool_use from three input_json_delta fragments', async () => {
    const input = { month: '2026-01', limit: 5 };
    const { chunks } = await run(anthropicToolUse(1, 'tu_1', 'spending_summary', input, 3));
    expect(chunks).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'spending_summary', input }, { type: 'done' }]);
  });

  it('malformed tool JSON yields an empty input instead of throwing', async () => {
    const { chunks } = await run(anthropicToolUseRaw(0, 'tu_bad', 'x', ['{"a":', '1']));
    expect(chunks).toEqual([{ type: 'tool_use', id: 'tu_bad', name: 'x', input: {} }, { type: 'done' }]);
  });

  it('keeps two interleaved tool blocks separate', async () => {
    const a = { q: 'first' }, b = { q: 'second', n: 2 };
    const { chunks } = await run(interleave(
      anthropicToolUse(0, 'A', 'ta', a, 3), anthropicToolUse(1, 'B', 'tb', b, 3)));
    const tools = chunks.filter((c) => c.type === 'tool_use');
    expect(tools).toEqual(expect.arrayContaining([
      { type: 'tool_use', id: 'A', name: 'ta', input: a },
      { type: 'tool_use', id: 'B', name: 'tb', input: b },
    ]));
    expect(tools).toHaveLength(2);
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });
});

describe('OpenAI provider', () => {
  beforeEach(() => { process.env.OPENAI_API_KEY = 'k'; });
  const run = async (events: unknown[], messages: Message[] = [{ role: 'user', content: 'hi' }], tools: ToolDef[] = []) => {
    sdk.openaiStream.mockReturnValue(openaiStream(events as never));
    const chunks = await collect('SYS', messages, tools);
    return { chunks, req: sdk.openaiStream.mock.calls[0][0] };
  };

  it('request mapping: system first, tool_calls with JSON arguments, null content for empty text, tool role results', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } },
        { type: 'tool_use', id: 'c2', name: 'b', input: {} },
      ] },
      { role: 'tool_result', tool_use_id: 'c1', content: 'r1' },
      { role: 'tool_result', tool_use_id: 'c2', content: 'r2' },
    ];
    const { req } = await run([], messages);
    expect(req.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(req.messages[2]).toEqual({
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
        { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    });
    expect(req.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'r1' });
    expect(req.messages[4]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'r2' });
    expect(req.tools).toBeUndefined();
  });

  it('streams text then done', async () => {
    const { chunks } = await run([...openaiText('a', 'b'), openaiFinish('stop')]);
    expect(chunks).toEqual([{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }, { type: 'done' }]);
  });

  it('accumulates tool-call arguments across chunks and flushes on finish_reason tool_calls', async () => {
    const input = { month: '2026-01', limit: 5 };
    const { chunks } = await run([...openaiToolCall(0, 'c1', 'spending_summary', input, 3), openaiFinish('tool_calls')]);
    expect(chunks).toEqual([{ type: 'tool_use', id: 'c1', name: 'spending_summary', input }, { type: 'done' }]);
  });

  it('keeps tool calls at index 0 and 1 separate', async () => {
    const { chunks } = await run([
      ...openaiToolCall(0, 'c0', 'ta', { a: 1 }, 2),
      ...openaiToolCall(1, 'c1', 'tb', { b: 2 }, 2),
      openaiFinish('tool_calls'),
    ]);
    expect(chunks.filter((c) => c.type === 'tool_use')).toEqual([
      { type: 'tool_use', id: 'c0', name: 'ta', input: { a: 1 } },
      { type: 'tool_use', id: 'c1', name: 'tb', input: { b: 2 } },
    ]);
  });

  it('malformed tool arguments yield an empty input instead of throwing', async () => {
    const bad = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":' } }] }, finish_reason: null }] }];
    const { chunks } = await run([...bad, openaiFinish('tool_calls')]);
    expect(chunks).toEqual([{ type: 'tool_use', id: 'c1', name: 't', input: {} }, { type: 'done' }]);
  });

  it('flushes on a stop finish too', async () => {
    const { chunks } = await run([...openaiToolCall(0, 'c1', 't', { a: 1 }), openaiFinish('stop')]);
    expect(chunks.filter((c) => c.type === 'tool_use')).toHaveLength(1);
  });

  it('emits each tool call once even if a tool_calls finish is followed by a stop chunk', async () => {
    const { chunks } = await run([...openaiToolCall(0, 'c1', 't', { a: 1 }), openaiFinish('tool_calls'), openaiFinish('stop')]);
    expect(chunks.filter((c) => c.type === 'tool_use')).toHaveLength(1);
  });

  it('flushes a complete tool call when the stream ends without a finish reason', async () => {
    const { chunks } = await run(openaiToolCall(0, 'c1', 't', { a: 1 }));
    expect(chunks.filter((c) => c.type === 'tool_use')).toEqual([{ type: 'tool_use', id: 'c1', name: 't', input: { a: 1 } }]);
  });

  it('flushes a complete tool call on a length finish', async () => {
    const { chunks } = await run([...openaiToolCall(0, 'c1', 't', { a: 1 }), openaiFinish('length')]);
    expect(chunks.filter((c) => c.type === 'tool_use')).toHaveLength(1);
  });

  it('drops a tool call with truncated arguments on a length finish', async () => {
    const bad = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":' } }] }, finish_reason: null }] }];
    const { chunks } = await run([...bad, openaiFinish('length')]);
    expect(chunks).toEqual([{ type: 'done' }]);
  });

  it('on a length finish emits only the complete call when another is cut off', async () => {
    const cut = [{ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 't2', arguments: '{"b":' } }] }, finish_reason: null }] }];
    const { chunks } = await run([...openaiToolCall(0, 'c1', 't', { a: 1 }), ...cut, openaiFinish('length')]);
    expect(chunks).toEqual([{ type: 'tool_use', id: 'c1', name: 't', input: { a: 1 } }, { type: 'done' }]);
  });

  it('drops a truncated call that has arguments but no name on a length finish', async () => {
    const nameless = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { arguments: '{"a":' } }] }, finish_reason: null }] }];
    const { chunks } = await run([...nameless, openaiFinish('length')]);
    expect(chunks).toEqual([{ type: 'done' }]);
  });

  it('tolerates mid-stream chunks with empty choices or usage only', async () => {
    const { chunks } = await run([
      { choices: [] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ...openaiToolCall(0, 'c1', 't', { a: 1 }),
      openaiFinish('tool_calls'),
    ]);
    expect(chunks).toEqual([{ type: 'tool_use', id: 'c1', name: 't', input: { a: 1 } }, { type: 'done' }]);
  });

  it('drops a tool call cut off mid-arguments when the stream ends', async () => {
    const bad = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":' } }] }, finish_reason: null }] }];
    const { chunks } = await run(bad);
    expect(chunks).toEqual([{ type: 'done' }]);
  });
});
