import { describe, it, expect, vi } from 'vitest';

// Only executeTool is stubbed; the REAL WRITE_TOOLS set is what gates the agent.
vi.mock('../core/llm-provider.js', async (orig) => ({
  ...(await orig<typeof import('../core/llm-provider.js')>()),
  streamResponse: vi.fn(), detectProvider: () => 'anthropic', getProviderModel: () => 'm',
}));
vi.mock('../core/tools.js', async (orig) => ({
  ...(await orig<typeof import('../core/tools.js')>()),
  executeTool: vi.fn(async () => 'ok'),
}));

import { streamResponse } from '../core/llm-provider.js';
import { executeTool, WRITE_TOOLS } from '../core/tools.js';
import { runAgentTurn } from '../core/agent.js';

// Proves every name currently IN WRITE_TOOLS is gated by the agent, NOT that the
// set is complete: WRITE_TOOLS carries a "keep in sync with executeTool" comment,
// and a mutating tool missing from it would not be exercised here.
// Hardcoded so that REMOVING a name from WRITE_TOOLS turns this test red
// (iterating the live set alone would just drop the case silently).
const KNOWN_WRITE_TOOLS = [
  'edit_transaction', 'clear_edit', 'ignore_transaction', 'add_transaction',
  'set_transaction_date', 'clear_transaction_date',
  'add_rule', 'delete_rule', 'add_name_rule', 'delete_name_rule',
  'tag_transaction', 'toggle_hidden_category', 'sync', 'import_balance_history',
  'show_canvas', 'load_canvas', 'delete_canvas',
];

describe('real WRITE_TOOLS gate', () => {
  it.each([...new Set([...KNOWN_WRITE_TOOLS, ...WRITE_TOOLS])])('%s asks for confirmation and is not executed when declined', async (name) => {
    let i = 0;
    vi.mocked(streamResponse).mockImplementation((async function* () {
      if (i++ === 0) yield { type: 'tool_use', id: 't', name, input: {} };
      else yield { type: 'text', delta: 'x' };
    }) as never);
    vi.mocked(executeTool).mockClear();
    const onConfirm = vi.fn(async () => false);
    await runAgentTurn('q', [], { onText: vi.fn(), onToolCall: vi.fn(), onConfirm, onNavigate: vi.fn() });
    expect(onConfirm).toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
