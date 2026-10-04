import { describe, it, expect, beforeEach, vi } from 'vitest';
import { electronMock, makeEvent } from '../../helpers/makeElectronMock.js';

vi.mock('electron', async () => (await import('../../helpers/makeElectronMock.js')).electronModule());
vi.mock('../../../core/agent.js', () => ({ runAgentTurn: vi.fn() }));
vi.mock('../../../core/llm-provider.js', () => ({ detectProvider: vi.fn(), getProviderModel: vi.fn() }));

// Bind the (cached) electron mock to this file's helper instance before any resetModules.
await import('electron');

type Hist = Array<{ role: string; content: string }>;
let runAgentTurn: ReturnType<typeof vi.fn>;
let detectProvider: ReturnType<typeof vi.fn>;
let getProviderModel: ReturnType<typeof vi.fn>;
let rejectPendingConfirms: () => void;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  electronMock.reset();
  vi.resetModules(); // history / pendingConfirms / nextConfirmId / inflight are module-level
  ({ runAgentTurn } = (await import('../../../core/agent.js')) as any);
  ({ detectProvider, getProviderModel } = (await import('../../../core/llm-provider.js')) as any);
  const mod = await import('../../../gui/main/agent-ipc.js');
  rejectPendingConfirms = mod.rejectPendingConfirms;
  mod.registerAgentIpc();
});

describe('agent-ipc channels and provider', () => {
  it('registers exactly the four channels', () => {
    expect([...electronMock.handlers.keys()].sort()).toEqual(
      ['agent:provider', 'agent:reset', 'agent:respond-confirm', 'agent:run'],
    );
  });

  it('agent:provider returns provider/model truncated to three id segments', async () => {
    detectProvider.mockReturnValue('anthropic');
    getProviderModel.mockReturnValue('claude-sonnet-4-5-20250929');
    expect(await electronMock.invoke('agent:provider')).toBe('anthropic/claude-sonnet-4');
    expect(getProviderModel).toHaveBeenCalledWith('anthropic');
  });

  it('agent:provider returns null when no provider is configured', async () => {
    detectProvider.mockImplementation(() => { throw new Error('no key'); });
    expect(await electronMock.invoke('agent:provider')).toBeNull();
  });
});

describe('agent:run', () => {
  it('forwards callbacks to the sender as agent:* pushes', async () => {
    const ev = makeEvent();
    runAgentTurn.mockImplementation(async (_m: string, _h: unknown, cb: any) => {
      cb.onText('hel');
      cb.onToolCall('list_transactions', 'Listing');
      cb.onNavigate('transactions', 'coffee');
      const answer = cb.onConfirm('Delete rule?');
      // resolve it so the turn can end
      await electronMock.invoke('agent:respond-confirm', 1, true);
      expect(await answer).toBe(true);
    });
    await electronMock.invokeWith(ev, 'agent:run', 'hi');
    expect(ev.sender.send.mock.calls).toEqual([
      ['agent:text', 'hel'],
      ['agent:tool', 'list_transactions', 'Listing'],
      ['agent:navigate', 'transactions', 'coffee'],
      ['agent:confirm', 1, 'Delete rule?'],
    ]);
    expect(runAgentTurn.mock.calls[0][0]).toBe('hi');
  });

  it('passes the same history array every turn, accumulating across turns', async () => {
    const seen: Hist[] = [];
    runAgentTurn.mockImplementation(async (m: string, h: Hist) => {
      seen.push(h);
      h.push({ role: 'user', content: m });
    });
    await electronMock.invoke('agent:run', 'one');
    await electronMock.invoke('agent:run', 'two');
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1].map((x) => x.content)).toEqual(['one', 'two']);
  });

  it('rolls back a partial turn on failure and rethrows the same error', async () => {
    let histRef!: Hist;
    runAgentTurn.mockImplementationOnce(async (m: string, h: Hist) => {
      histRef = h;
      h.push({ role: 'user', content: m });
      h.push({ role: 'assistant', content: 'partial' });
      throw new Error('llm exploded');
    });
    await expect(electronMock.invoke('agent:run', 'bad')).rejects.toThrow('llm exploded');
    expect(histRef).toHaveLength(0);

    runAgentTurn.mockImplementationOnce(async (m: string, h: Hist) => { h.push({ role: 'user', content: m }); });
    await electronMock.invoke('agent:run', 'good');
    expect(histRef.map((x) => x.content)).toEqual(['good']);
  });

  it('keeps completed earlier turns when a later turn fails', async () => {
    let histRef!: Hist;
    runAgentTurn.mockImplementationOnce(async (m: string, h: Hist) => { histRef = h; h.push({ role: 'user', content: m }); });
    await electronMock.invoke('agent:run', 'one');
    runAgentTurn.mockImplementationOnce(async (m: string, h: Hist) => { h.push({ role: 'user', content: m }); throw new Error('x'); });
    await expect(electronMock.invoke('agent:run', 'two')).rejects.toThrow('x');
    expect(histRef.map((x) => x.content)).toEqual(['one']);
  });

  it('refuses a second turn while one is pending, then accepts after it finishes', async () => {
    const d = deferred();
    runAgentTurn.mockImplementationOnce(() => d.promise);
    const first = electronMock.invoke('agent:run', 'one');
    await tick();
    await expect(electronMock.invoke('agent:run', 'two')).rejects.toThrow(/already responding/);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    d.resolve();
    await first;
    runAgentTurn.mockResolvedValueOnce(undefined);
    await electronMock.invoke('agent:run', 'three');
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it('accepts a new turn after a failed one', async () => {
    runAgentTurn.mockRejectedValueOnce(new Error('boom'));
    await expect(electronMock.invoke('agent:run', 'one')).rejects.toThrow('boom');
    runAgentTurn.mockResolvedValueOnce(undefined);
    await expect(electronMock.invoke('agent:run', 'two')).resolves.toBeUndefined();
  });

  it('a destroyed sender gets no pushes and the turn still completes', async () => {
    const ev = makeEvent({ destroyed: true });
    runAgentTurn.mockImplementation(async (_m: string, _h: unknown, cb: any) => {
      cb.onText('x');
      cb.onToolCall('t', 'd');
      cb.onNavigate('s', undefined);
    });
    await expect(electronMock.invokeWith(ev, 'agent:run', 'hi')).resolves.toBeUndefined();
    expect(ev.sender.send).not.toHaveBeenCalled();
  });
});

describe('agent:reset', () => {
  it('empties history when idle', async () => {
    let histRef!: Hist;
    runAgentTurn.mockImplementation(async (m: string, h: Hist) => { histRef = h; h.push({ role: 'user', content: m }); });
    await electronMock.invoke('agent:run', 'one');
    expect(histRef).toHaveLength(1);
    await electronMock.invoke('agent:reset');
    expect(histRef).toHaveLength(0);
  });

  // Smell: reset mid-turn is silently ignored (resolves undefined, history kept),
  // so the renderer's "new chat" appears to succeed but the old context survives.
  it('mid-turn reset leaves history intact (current behaviour, silently ignored)', async () => {
    const d = deferred();
    let histRef!: Hist;
    runAgentTurn.mockImplementation(async (m: string, h: Hist) => {
      histRef = h;
      h.push({ role: 'user', content: m });
      await d.promise;
    });
    const run = electronMock.invoke('agent:run', 'one');
    await tick();
    await expect(electronMock.invoke('agent:reset')).resolves.toBeUndefined();
    expect(histRef).toHaveLength(1);
    d.resolve();
    await run;
  });
});

describe('confirm flow', () => {
  /** Start a turn that asks for confirmation(s); returns the confirm promises as they are requested. */
  function confirmingTurn(count = 1) {
    const answers: Promise<boolean>[] = [];
    const gate = deferred();
    runAgentTurn.mockImplementation(async (_m: string, _h: unknown, cb: any) => {
      for (let i = 0; i < count; i++) answers.push(cb.onConfirm(`q${i}`));
      await gate.promise;
    });
    return { answers, gate };
  }

  it('respond-confirm resolves true / false for the matching id, and ids increment', async () => {
    const ev = makeEvent();
    const { answers, gate } = confirmingTurn(2);
    const run = electronMock.invokeWith(ev, 'agent:run', 'x');
    await tick();
    expect(ev.sender.send.mock.calls).toEqual([['agent:confirm', 1, 'q0'], ['agent:confirm', 2, 'q1']]);
    await electronMock.invoke('agent:respond-confirm', 2, false);
    await electronMock.invoke('agent:respond-confirm', 1, true);
    expect(await Promise.all(answers)).toEqual([true, false]);
    gate.resolve();
    await run;
  });

  it('unknown or duplicate ids do not throw and do not re-resolve', async () => {
    const { answers, gate } = confirmingTurn(1);
    const run = electronMock.invoke('agent:run', 'x');
    await tick();
    await expect(electronMock.invoke('agent:respond-confirm', 99, true)).resolves.toBeUndefined();
    await electronMock.invoke('agent:respond-confirm', 1, true);
    await expect(electronMock.invoke('agent:respond-confirm', 1, false)).resolves.toBeUndefined();
    expect(await answers[0]).toBe(true);
    gate.resolve();
    await run;
  });

  it('ids keep increasing across turns', async () => {
    const ev = makeEvent();
    runAgentTurn.mockImplementation(async (_m: string, _h: unknown, cb: any) => {
      const a = cb.onConfirm('q');
      await electronMock.invoke('agent:respond-confirm', ev.sender.send.mock.calls.at(-1)![1], true);
      await a;
    });
    await electronMock.invokeWith(ev, 'agent:run', 'a');
    await electronMock.invokeWith(ev, 'agent:run', 'b');
    expect(ev.sender.send.mock.calls.map((c) => c[1])).toEqual([1, 2]);
  });

  it('rejectPendingConfirms resolves every pending confirm false and clears them', async () => {
    const { answers, gate } = confirmingTurn(2);
    const run = electronMock.invoke('agent:run', 'x');
    await tick();
    rejectPendingConfirms();
    expect(await Promise.all(answers)).toEqual([false, false]);
    // cleared: a late respond for an old id cannot throw
    await expect(electronMock.invoke('agent:respond-confirm', 1, true)).resolves.toBeUndefined();
    gate.resolve();
    await run;
  });

  it('a turn that errors with a confirm outstanding resolves it false', async () => {
    let answer!: Promise<boolean>;
    runAgentTurn.mockImplementation(async (_m: string, _h: unknown, cb: any) => {
      answer = cb.onConfirm('q');
      throw new Error('crash');
    });
    await expect(electronMock.invoke('agent:run', 'x')).rejects.toThrow('crash');
    expect(await answer).toBe(false);
  });

  it('a turn that finishes with a confirm outstanding resolves it false', async () => {
    let answer!: Promise<boolean>;
    runAgentTurn.mockImplementation(async (_m: string, _h: unknown, cb: any) => { answer = cb.onConfirm('q'); });
    await electronMock.invoke('agent:run', 'x');
    expect(await answer).toBe(false);
  });
});
