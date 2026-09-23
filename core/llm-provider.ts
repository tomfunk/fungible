/**
 * Provider-agnostic LLM interface for the fungible agent.
 * Supports Anthropic (ANTHROPIC_API_KEY) and OpenAI (OPENAI_API_KEY).
 * Auto-detects which key is present; Anthropic is preferred if both are set.
 *
 * Normalizes:
 *   - Message history (system / user / assistant / tool_result)
 *   - Tool definitions (JSON Schema parameters)
 *   - Streaming output (text deltas and tool calls)
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ─── Common types ─────────────────────────────────────────────────────────────

export type TextBlock     = { type: 'text';     text: string };
export type ToolUseBlock  = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ContentBlock  = TextBlock | ToolUseBlock;

export type SystemMessage      = { role: 'system';      content: string };
export type UserMessage        = { role: 'user';        content: string };
export type AssistantMessage   = { role: 'assistant';   content: ContentBlock[] };
export type ToolResultMessage  = { role: 'tool_result'; tool_use_id: string; content: string };

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema object
};

// Streaming chunks emitted by the provider
export type TextChunk     = { type: 'text';     delta: string };
export type ToolUseChunk  = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type DoneChunk     = { type: 'done' };
export type StreamChunk   = TextChunk | ToolUseChunk | DoneChunk;

export type ProviderName = 'anthropic' | 'openai';

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectProvider(): ProviderName {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY)    return 'openai';
  throw new Error(
    'No LLM API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.fungible/.env.'
  );
}

export function getProviderModel(provider: ProviderName): string {
  if (provider === 'anthropic') return process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
  return process.env.OPENAI_MODEL ?? 'gpt-5.4-nano';
}

// ─── Anthropic provider ───────────────────────────────────────────────────────

async function* streamAnthropic(
  system: string,
  messages: Message[],
  tools: ToolDef[],
  model: string,
): AsyncGenerator<StreamChunk> {
  const client = new Anthropic();

  // Convert common messages → Anthropic format
  // Anthropic: system is separate; tool_result folds into a user message
  const anthMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled separately

    if (msg.role === 'user') {
      anthMessages.push({ role: 'user', content: msg.content });

    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlock[] = msg.content.map((b) => {
        if (b.type === 'text')     return { type: 'text', text: b.text } as Anthropic.TextBlock;
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input } as Anthropic.ToolUseBlock;
        return b as Anthropic.ContentBlock;
      });
      anthMessages.push({ role: 'assistant', content });

    } else if (msg.role === 'tool_result') {
      // Anthropic expects tool_result inside a user message
      const last = anthMessages[anthMessages.length - 1];
      const toolResultBlock: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_use_id,
        content: msg.content,
      };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(toolResultBlock);
      } else {
        anthMessages.push({ role: 'user', content: [toolResultBlock] });
      }
    }
  }

  const anthTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }));

  const stream = client.messages.stream({
    model,
    max_tokens: 4096,
    system,
    messages: anthMessages,
    tools: anthTools.length ? anthTools : undefined,
  });

  // Accumulate tool input JSON across deltas; id is available at content_block_start
  const toolInputAccum: Record<number, string> = {};
  const toolMeta: Record<number, { id: string; name: string }> = {};

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        toolInputAccum[event.index] = '';
        toolMeta[event.index] = { id: event.content_block.id, name: event.content_block.name };
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { type: 'text', delta: event.delta.text };
      } else if (event.delta.type === 'input_json_delta') {
        toolInputAccum[event.index] = (toolInputAccum[event.index] ?? '') + event.delta.partial_json;
      }
    } else if (event.type === 'content_block_stop') {
      const meta = toolMeta[event.index];
      if (meta) {
        const raw = toolInputAccum[event.index] ?? '{}';
        let input: Record<string, unknown> = {};
        try { input = raw ? JSON.parse(raw) : {}; } catch { /* malformed — leave empty */ }
        yield { type: 'tool_use', id: meta.id, name: meta.name, input };
        delete toolInputAccum[event.index];
        delete toolMeta[event.index];
      }
    }
  }

  yield { type: 'done' };
}

// ─── OpenAI provider ──────────────────────────────────────────────────────────

async function* streamOpenAI(
  system: string,
  messages: Message[],
  tools: ToolDef[],
  model: string,
): AsyncGenerator<StreamChunk> {
  const client = new OpenAI();

  // Convert common messages → OpenAI format
  const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      oaiMessages.push({ role: 'user', content: msg.content });

    } else if (msg.role === 'assistant') {
      const textParts = msg.content.filter((b): b is TextBlock => b.type === 'text');
      const toolCalls = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

      const oaiMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textParts.map((b) => b.text).join('') || null,
      };
      if (toolCalls.length) {
        oaiMsg.tool_calls = toolCalls.map((b) => ({
          id:       b.id,
          type:     'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      }
      oaiMessages.push(oaiMsg);

    } else if (msg.role === 'tool_result') {
      oaiMessages.push({
        role:         'tool',
        tool_call_id: msg.tool_use_id,
        content:      msg.content,
      });
    }
  }

  const oaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name:        t.name,
      description: t.description,
      parameters:  t.parameters,
    },
  }));

  const stream = client.chat.completions.stream({
    model,
    messages: oaiMessages,
    tools:    oaiTools.length ? oaiTools : undefined,
    stream:   true,
  });

  // Accumulate tool call arguments across chunks
  const toolCallAccum: Record<number, { id: string; name: string; args: string }> = {};

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      yield { type: 'text', delta: delta.content };
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCallAccum[idx]) {
          toolCallAccum[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
        }
        if (tc.id)              toolCallAccum[idx].id   = tc.id;
        if (tc.function?.name)  toolCallAccum[idx].name = tc.function.name;
        if (tc.function?.arguments) {
          toolCallAccum[idx].args += tc.function.arguments;
        }
      }
    }

    const finishReason = chunk.choices[0]?.finish_reason;
    if (finishReason === 'tool_calls' || finishReason === 'stop') {
      for (const [, tc] of Object.entries(toolCallAccum)) {
        let input: Record<string, unknown> = {};
        try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { /* ignore */ }
        yield { type: 'tool_use', id: tc.id, name: tc.name, input };
      }
    }
  }

  yield { type: 'done' };
}

// ─── Unified stream function ──────────────────────────────────────────────────

/**
 * Stream a response from the detected provider.
 * Yields text deltas, tool_use events, and a final done event.
 */
export async function* streamResponse(
  system: string,
  messages: Message[],
  tools: ToolDef[],
): AsyncGenerator<StreamChunk> {
  const provider = detectProvider();
  const model    = getProviderModel(provider);

  if (provider === 'anthropic') {
    yield* streamAnthropic(system, messages, tools, model);
  } else {
    yield* streamOpenAI(system, messages, tools, model);
  }
}

/**
 * Build an assistant message from collected content blocks (for history).
 */
export function makeAssistantMessage(blocks: ContentBlock[]): AssistantMessage {
  return { role: 'assistant', content: blocks };
}
