// Handles the ad-hoc channels the renderer talks to outside the
// call(ns,fn,args) surface: the agent chat (ChatDrawer.tsx) and the
// refresh/sync-status push channels (useRefresh.tsx, useSyncStatus.tsx,
// Accounts.tsx's manual refresh) — Bridge.invoke and Bridge.on.
//
// STATUS:
//   - agent:provider / agent:reset / agent:run are real, wired to
//     web/src/agent-llm.ts, which streams a genuine conversation through
//     the sync server's POST /llm/anthropic|openai proxy (Bearer auth, same pattern
//     as account-client.ts's authClient/plaidClient). See that file's header
//     comment for the one real gap: core/agent.ts's tool-calling loop
//     (core/tools.ts's 30+ data/write tools, the `show` UI-navigation tool)
//     isn't bundlable into a browser build yet, so this is plain
//     conversation only — no querying/editing the user's data, no UI
//     navigation. agent:tool / agent:confirm / agent:navigate are therefore
//     never emitted here (nothing to confirm when no write tool ever runs).
//   - agent:respond-confirm is a no-op below for the same reason — kept so
//     ChatDrawer's call site doesn't throw, even though nothing ever sends
//     the agent:confirm event that would make it fire for real.
//   - sync:refresh / sync:refresh-cancel is the Accounts screen's manual
//     single-item resync; on the web this should go through the sync server's sync
//     routes (see core/sync.ts's callers) rather than core/sync.ts directly
//     — same "wrong architecture for local core" reasoning as the `sync`
//     namespace in core-bridge.ts.
//   - refresh / sync-status / sync:refresh-progress are push channels the
//     Electron main process forwards from core's EventEmitters
//     (core/refresh.ts, core/sync-status.ts — plain listener sets, so they
//     are bundle-portable). Wire them in here (or have mutations call `emit` below
//     directly from browser-side code).
//
// `on` is a real, working pub/sub (subscribing never throws, so hooks mount
// cleanly). `invoke` handles the `agent:*` channels for real (see above) and
// rejects with a specific message for everything else (`sync:*`); every
// other current call site doesn't await it or doesn't handle the rejection,
// so that surfaces as a console warning rather than a crash.

import { getProviderLabel, resetChat, runChatTurn } from './agent-llm.js';

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();

/** Exposed for when a browser-safe replacement for core's refresh/sync-status
 *  EventEmitters lands — call this to push an event to every `on(channel,
 *  ...)` subscriber, exactly like win.webContents.send does today. */
export function emit(channel: string, ...args: unknown[]): void {
  for (const l of listeners.get(channel) ?? []) l(...args);
}

export function onChannel(channel: string, cb: Listener): () => void {
  let set = listeners.get(channel);
  if (!set) listeners.set(channel, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

export async function invokeChannel(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    case 'agent:provider':
      return getProviderLabel();
    case 'agent:reset':
      resetChat();
      return;
    case 'agent:run':
      return runChatTurn(args[0] as string, (delta) => emit('agent:text', delta));
    case 'agent:respond-confirm':
      // No write tool ever runs here (see the header comment), so no
      // agent:confirm is ever emitted for the real ChatDrawer handler above
      // to answer — this exists only so a call site doesn't throw.
      return;
    default:
      throw new Error(`"${channel}" isn't wired up in the web build yet (see web/src/agent-bridge.ts).`);
  }
}
