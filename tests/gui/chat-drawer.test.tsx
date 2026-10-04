// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { deferred } from '../helpers/deferred.js';
import { installBridge, Providers, type BridgeHarness } from './helpers/renderGui.js';
import { filterSummary } from '../../core/filters.js';
import { ChatDrawer } from '../../gui/renderer/src/components/ChatDrawer.js';

let bridge: BridgeHarness;
let runCalls: unknown[][];
let confirmCalls: unknown[][];
let resetCalls: number;
let runHandler: (text: string) => Promise<unknown>;

function setup(opts: { provider?: string | null; initialFilter?: import('../../core/filters.js').Filter; navigate?: (...a: never[]) => void; filterBar?: boolean } = {}) {
  const provider = opts.provider === undefined ? 'anthropic/claude-sonnet-4' : opts.provider;
  bridge.onInvoke('agent:provider', async () => provider);
  bridge.onInvoke('agent:run', async (...args) => { runCalls.push(args); return runHandler(args[0] as string); });
  bridge.onInvoke('agent:reset', async () => { resetCalls++; });
  bridge.onInvoke('agent:respond-confirm', async (...args) => { confirmCalls.push(args); });
  return render(
    <Providers navigate={opts.navigate as never} filterBar={opts.filterBar} initialFilter={opts.initialFilter}>
      <ChatDrawer />
    </Providers>,
  );
}

const toggle = () => screen.getByTitle('Toggle with `');
async function openDrawer() {
  await userEvent.click(toggle());
  return (await screen.findByRole('textbox')) as HTMLInputElement;
}
async function send(input: HTMLInputElement, text: string) {
  await userEvent.type(input, `${text}{Enter}`);
}

beforeEach(() => {
  // jsdom doesn't implement Element.scrollTo (the drawer auto-scrolls its transcript).
  Element.prototype.scrollTo = vi.fn() as never;
  bridge = installBridge();
  runCalls = [];
  confirmCalls = [];
  resetCalls = 0;
  runHandler = async () => undefined;
});
afterEach(cleanup);

describe('ChatDrawer provider state', () => {
  it('no provider: collapsed bar warns, drawer input is disabled with key guidance', async () => {
    setup({ provider: null });
    expect(await screen.findByText('no API key set')).toBeTruthy();
    const input = await openDrawer();
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/ANTHROPIC_API_KEY or OPENAI_API_KEY/)).toBeTruthy();
  });

  it('with provider: shows the model and an enabled input', async () => {
    setup();
    expect(await screen.findByText(/ask anything about your finances \(anthropic\/claude-sonnet-4\)/)).toBeTruthy();
    const input = await openDrawer();
    expect(screen.getByText('(anthropic/claude-sonnet-4)')).toBeTruthy();
    expect(input.disabled).toBe(false);
  });
});

describe('ChatDrawer toggling', () => {
  it('click opens; backtick toggles only outside fields; Esc in the input minimizes', async () => {
    setup();
    await screen.findByText(/anthropic\/claude-sonnet-4/);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.keyDown(document.body, { key: '`' });
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    // backtick while typing in the input does not close the drawer
    fireEvent.keyDown(input, { key: '`' });
    expect(screen.queryByRole('textbox')).not.toBeNull();
    // ...nor inside a select
    const sel = document.body.appendChild(document.createElement('select'));
    fireEvent.keyDown(sel, { key: '`' });
    expect(screen.queryByRole('textbox')).not.toBeNull();
    sel.remove();
    // outside a field it closes
    fireEvent.keyDown(document.body, { key: '`' });
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    // reopen via click, Esc minimizes
    const input2 = await openDrawer();
    fireEvent.keyDown(input2, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('opens with a click on the minimize control reversed', async () => {
    setup();
    await openDrawer();
    await userEvent.click(screen.getByRole('button', { name: /minimize/ }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('ChatDrawer sending', () => {
  it('trims input, streams live text with a cursor, then settles into one Agent message', async () => {
    const d = deferred<void>();
    runHandler = async () => {
      bridge.emit('agent:text', 'Hel');
      bridge.emit('agent:text', 'lo');
      await d.promise;
    };
    setup();
    const input = await openDrawer();
    await send(input, '  how much on dining?  ');
    expect(runCalls).toEqual([['how much on dining?']]);
    expect(screen.getByText('how much on dining?')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    // live stream: text + cursor, one Agent label, not "thinking"
    await waitFor(() => expect(screen.getByText('▊').parentElement!.textContent).toBe('Hello▊'));
    expect(screen.getAllByText('Agent').length).toBe(1);
    expect(screen.queryByText('⟳ thinking…')).toBeNull();
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByText('▊')).toBeNull());
    expect(screen.getAllByText('Agent')).toHaveLength(1);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText('⟳ thinking…')).toBeNull();
  });

  it('shows thinking before any text arrives', async () => {
    const d = deferred<void>();
    runHandler = () => d.promise;
    setup();
    const input = await openDrawer();
    await send(input, 'hi');
    expect(await screen.findByText('⟳ thinking…')).toBeTruthy();
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByText('⟳ thinking…')).toBeNull());
    // no streamed text -> no assistant message
    expect(screen.queryByText('Agent')).toBeNull();
  });

  it('ignores empty/whitespace Enter', async () => {
    setup();
    const input = await openDrawer();
    await userEvent.type(input, '   {Enter}');
    await userEvent.type(input, '{Enter}');
    expect(runCalls).toHaveLength(0);
    expect(screen.queryByText('You')).toBeNull();
  });

  it('a second Enter while a run is pending does not start another run', async () => {
    const d = deferred<void>();
    runHandler = () => d.promise;
    setup();
    const input = await openDrawer();
    await send(input, 'first');
    await userEvent.type(input, 'second{Enter}');
    expect(runCalls).toEqual([['first']]);
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByText('⟳ thinking…')).toBeNull());
  });

  it('a rejected run shows the error, stops streaming and the input is usable again', async () => {
    runHandler = async () => { throw new Error('boom'); };
    setup();
    const input = await openDrawer();
    await send(input, 'hi');
    expect(await screen.findByText('Error: boom')).toBeTruthy();
    expect(screen.queryByText('⟳ thinking…')).toBeNull();
    expect(screen.queryByText('▊')).toBeNull();
    runHandler = async () => undefined;
    await send(input, 'again');
    expect(runCalls).toEqual([['hi'], ['again']]);
  });

  it('renders a tool event as a transcript line', async () => {
    const d = deferred<void>();
    runHandler = async () => { bridge.emit('agent:tool', 'x', 'Querying spend'); await d.promise; };
    setup();
    const input = await openDrawer();
    await send(input, 'q');
    expect(await screen.findByText('⟳ Querying spend')).toBeTruthy();
    await act(async () => d.resolve());
  });
});

describe('ChatDrawer confirmation', () => {
  async function pendingConfirm() {
    const d = deferred<void>();
    runHandler = async () => { bridge.emit('agent:confirm', 7, 'Delete 3 transactions'); await d.promise; };
    setup();
    const input = await openDrawer();
    await send(input, 'delete');
    await screen.findByText('⚠ Delete 3 transactions');
    return d;
  }

  it('Confirm answers (id, true) and logs the description', async () => {
    const d = await pendingConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(confirmCalls).toEqual([[7, true]]);
    expect(screen.getByText('✓ Delete 3 transactions')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    await act(async () => d.resolve());
  });

  it('Cancel answers (id, false) and logs the cancellation', async () => {
    const d = await pendingConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmCalls).toEqual([[7, false]]);
    expect(screen.getByText('✗ Cancelled')).toBeTruthy();
    expect(screen.queryByText('✓ Delete 3 transactions')).toBeNull();
    await act(async () => d.resolve());
  });

  it('a pending confirm is dropped when the run ends', async () => {
    const d = await pendingConfirm();
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull());
  });
});

describe('ChatDrawer navigation events', () => {
  it('trends + category navigates with focusCategory', async () => {
    const navigate = vi.fn();
    setup({ navigate });
    await screen.findByText(/anthropic/);
    act(() => bridge.emit('agent:navigate', 'trends', { category: 'Dining' }));
    expect(navigate).toHaveBeenCalledWith('trends', { focusCategory: 'Dining' });
  });

  it('tags + tag navigates with focusTag; no filter navigates with undefined', async () => {
    const navigate = vi.fn();
    setup({ navigate });
    await screen.findByText(/anthropic/);
    act(() => bridge.emit('agent:navigate', 'tags', { tag: 'trip' }));
    expect(navigate).toHaveBeenLastCalledWith('tags', { focusTag: 'trip' });
    act(() => bridge.emit('agent:navigate', 'accounts'));
    expect(navigate).toHaveBeenLastCalledWith('accounts', undefined);
  });

  it('transactions + category sets the shared filter (visible as a FilterBar chip) and navigates', async () => {
    const navigate = vi.fn();
    setup({ navigate, filterBar: true });
    await screen.findByText(/anthropic/);
    expect(screen.getByRole('button', { name: '⌕ filter' })).toBeTruthy();
    act(() => bridge.emit('agent:navigate', 'transactions', { category: 'Dining', from: '2026-05-01' }));
    expect(await screen.findByRole('button', { name: '⌕ filter: 1 category' })).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith('transactions', { from: '2026-05-01' });
  });
});

describe('ChatDrawer edge cases', () => {
  it('hides the thinking line while a confirm is pending', async () => {
    const d = deferred<void>();
    runHandler = async () => { bridge.emit('agent:confirm', 1, 'Del'); await d.promise; };
    setup();
    const input = await openDrawer();
    await send(input, 'x');
    await screen.findByText('⚠ Del');
    expect(screen.queryByText('⟳ thinking…')).toBeNull();
    await act(async () => d.resolve());
  });

  it('caps the transcript at 200 messages, evicting the oldest', async () => {
    runHandler = async () => { for (let i = 0; i < 201; i++) bridge.emit('agent:tool', 'x', `t${i}`); };
    setup();
    const input = await openDrawer();
    await send(input, 'first-user-msg');
    await screen.findByText('⟳ t200');
    expect(screen.queryByText('⟳ t0')).toBeNull();
    expect(screen.queryByText('first-user-msg')).toBeNull(); // 202 added, 2 evicted
    expect(screen.getByText('⟳ t1')).toBeTruthy();
  });

  it('transactions navigation merges into the existing sticky filter', async () => {
    setup({ filterBar: true, navigate: vi.fn(), initialFilter: { accounts: ['a1'] } });
    await screen.findByText(/anthropic/);
    act(() => bridge.emit('agent:navigate', 'transactions', { category: 'Dining' }));
    // Both dimensions present (account kept, category added), rendered by the app's own summary.
    const label = `⌕ filter: ${filterSummary({ accounts: ['a1'], categories: ['Dining'] })}`;
    expect(await screen.findByRole('button', { name: label })).toBeTruthy();
  });
});

describe('ChatDrawer clear', () => {
  it('appears only after the first message, resets the agent and empties the transcript', async () => {
    setup();
    const input = await openDrawer();
    expect(screen.queryByRole('button', { name: 'clear' })).toBeNull();
    await send(input, 'hello there');
    await screen.findByText('hello there');
    await userEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(resetCalls).toBe(1);
    expect(screen.queryByText('hello there')).toBeNull();
    expect(screen.queryByRole('button', { name: 'clear' })).toBeNull();
  });
});
