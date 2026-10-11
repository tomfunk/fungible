import { ipcMain } from 'electron';
import { runAgentTurn } from '../../core/agent.js';
import type { Message } from '../../core/llm-provider.js';
import { detectProvider, getProviderModel } from '../../core/llm-provider.js';

// Conversation history lives in main (core mutates it in place across turns);
// the renderer keeps only a display transcript.
const history: Message[] = [];
const pendingConfirms = new Map<number, (yes: boolean) => void>();
let nextConfirmId = 1;
let inflight = false;
// Set by agent:reset mid-turn: the turn's callbacks start throwing so core's
// stream loop unwinds, and the run's catch rolls the partial turn back.
let aborted = false;
let currentTurn: Promise<void> | null = null;

class TurnAborted extends Error {
  constructor() {
    super('Agent turn cancelled');
  }
}

export function registerAgentIpc() {
  ipcMain.handle('agent:provider', () => {
    try {
      const p = detectProvider();
      return `${p}/${getProviderModel(p).split('-').slice(0, 3).join('-')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('agent:reset', async () => {
    if (inflight) {
      // Abort the turn and let it unwind before clearing: clearing under a
      // streaming turn would corrupt its history.
      aborted = true;
      rejectPendingConfirms();
      await currentTurn?.catch(() => {});
    }
    history.length = 0;
  });

  ipcMain.handle('agent:run', async (e, userMessage: string) => {
    if (inflight) throw new Error('The agent is already responding — wait for the current turn to finish');
    inflight = true;
    aborted = false;
    const send = (channel: string, ...args: unknown[]) => {
      if (aborted) throw new TurnAborted();
      if (!e.sender.isDestroyed()) e.sender.send(channel, ...args);
    };
    const historyLenBefore = history.length;
    try {
      const turn = runAgentTurn(userMessage, history, {
        onText: (delta) => send('agent:text', delta),
        onToolCall: (name, desc) => send('agent:tool', name, desc),
        onNavigate: (screen, filter) => send('agent:navigate', screen, filter),
        onConfirm: (desc) =>
          new Promise<boolean>((resolve) => {
            if (aborted) return resolve(false);
            const id = nextConfirmId++;
            pendingConfirms.set(id, resolve);
            send('agent:confirm', id, desc);
          }),
      });
      currentTurn = turn;
      await turn;
      if (aborted) throw new TurnAborted();
    } catch (err) {
      history.splice(historyLenBefore); // roll back the partial turn
      if (err instanceof TurnAborted || aborted) return; // cancelled by reset: not an error
      throw err;
    } finally {
      inflight = false;
      currentTurn = null;
      rejectPendingConfirms(); // any confirm still pending belongs to a failed turn
    }
  });

  ipcMain.handle('agent:respond-confirm', (_e, id: number, yes: boolean) => {
    pendingConfirms.get(id)?.(yes);
    pendingConfirms.delete(id);
  });
}

/** Cancel pending confirms (e.g. window closed) so turns don't hang forever. */
export function rejectPendingConfirms() {
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
}
