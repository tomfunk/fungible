/**
 * Scripted SDK stream events for core/llm-provider.ts.
 *
 * The provider does `new Anthropic().messages.stream(...)` and
 * `new OpenAI().chat.completions.stream(...)`, then `for await`s the result.
 * So a fake only needs `stream()` returning an async iterable of these events.
 *
 *   vi.mock('@anthropic-ai/sdk', () => ({ default: class {
 *     messages = { stream: vi.fn(() => anthropicStream(anthropicToolUse('t1', 'list_tags', { a: 1 }, 2))) };
 *   } }));
 */

export type AnthropicEvent = Record<string, unknown>;

/** Async-iterable over events, as the SDK stream objects are. */
export async function* anthropicStream(events: AnthropicEvent[]): AsyncGenerator<AnthropicEvent> {
  for (const e of events) yield e;
}
export const openaiStream = anthropicStream;

export function anthropicText(index: number, ...deltas: string[]): AnthropicEvent[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ...deltas.map((text) => ({
      type: 'content_block_delta', index, delta: { type: 'text_delta', text },
    })),
    { type: 'content_block_stop', index },
  ];
}

/** Split `JSON.stringify(input)` into `parts` input_json_delta fragments. */
export function splitJson(input: unknown, parts: number): string[] {
  const raw = JSON.stringify(input);
  const size = Math.max(1, Math.ceil(raw.length / Math.max(1, parts)));
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += size) out.push(raw.slice(i, i + size));
  return out;
}

export function anthropicToolUse(
  index: number, id: string, name: string, input: unknown, parts = 2,
): AnthropicEvent[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...splitJson(input, parts).map((partial_json) => ({
      type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json },
    })),
    { type: 'content_block_stop', index },
  ];
}

/** Raw (possibly malformed) partial_json fragments, e.g. to test the empty-input fallback. */
export function anthropicToolUseRaw(
  index: number, id: string, name: string, fragments: string[],
): AnthropicEvent[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...fragments.map((partial_json) => ({
      type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json },
    })),
    { type: 'content_block_stop', index },
  ];
}

/**
 * Interleave several event lists round-robin (one event per turn), keeping each
 * list's own order. Use with two anthropicToolUse blocks at different indexes.
 */
export function interleave(...lists: AnthropicEvent[][]): AnthropicEvent[] {
  const out: AnthropicEvent[] = [];
  const max = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

export type OpenAIChunk = { choices: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> };

export function openaiText(...deltas: string[]): OpenAIChunk[] {
  return deltas.map((content) => ({ choices: [{ delta: { content }, finish_reason: null }] }));
}

/** First fragment carries id+name; the rest carry argument slices. */
export function openaiToolCall(
  index: number, id: string, name: string, input: unknown, parts = 2,
): OpenAIChunk[] {
  const frags = splitJson(input, parts);
  return frags.map((args, i) => ({
    choices: [{
      delta: {
        tool_calls: [{
          index,
          ...(i === 0 ? { id, type: 'function' } : {}),
          function: { ...(i === 0 ? { name } : {}), arguments: args },
        }],
      },
      finish_reason: null,
    }],
  }));
}

/** Terminal chunk; provider only flushes tool calls on 'tool_calls' or 'stop'. */
export function openaiFinish(reason: 'tool_calls' | 'stop' | 'length' = 'tool_calls'): OpenAIChunk {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}
