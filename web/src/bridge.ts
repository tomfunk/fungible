// Browser implementation of window.__bridge — the same `{ call, invoke, on }`
// shape gui/preload/index.ts exposes via Electron's contextBridge, so every
// screen under gui/renderer/src (imported unchanged) keeps working without
// knowing which platform it's on. See gui/renderer/src/api.ts for the Proxy
// that turns `api.ns.fn(...args)` into `window.__bridge.call(ns, fn, args)`.
import type { Bridge } from '../../gui/shared/api-types.js';
import { callCore, getDefaultDaysRequested, getLastSyncedAt } from './core-bridge.js';
import {
  plaidClient, syncNow, getWebSyncInfo, connect, signOut, signOutAndErase, eraseLocalData, getAccountState,
} from './account-client.js';
import type { ConnectOptions, CycleSummary } from '../../gui/shared/account-types.js';
import { linkBank, cancelLink } from './plaid-link.js';
import { invokeChannel, onChannel, emit } from './agent-bridge.js';
import { onRefresh } from '../../core/refresh.js';
import { isDbPersistent } from './local-data.js';

async function call(ns: string, fn: string, args: unknown[]): Promise<unknown> {
  if (ns === 'account') {
    // Backs Settings.tsx's AccountPanel; the Electron side is gui/main/account-sync.ts.
    switch (fn) {
      case 'getSyncState': return getAccountState();
      case 'connect': return connect(args[0] as string, args[1] as string, (args[2] ?? {}) as ConnectOptions);
      case 'syncNow': {
        const r = (await syncNow())[0];
        if (r?.error) throw new Error(r.error);
        return (r?.cycle ?? null) as CycleSummary | null;
      }
      case 'disconnect': return signOut();
      case 'signOutAndErase': return signOutAndErase();
      case 'eraseLocalData': return eraseLocalData();
      default: throw new Error(`web bridge: unknown call account.${fn}`);
    }
  }

  if (ns === 'app' && fn === 'getVersion') return 'web';
  if (ns === 'app' && fn === 'isPersistent') return isDbPersistent();

  // Desktop-only concepts the shared renderer calls unconditionally on boot;
  // resolve to their "nothing here" value instead of throwing into the
  // renderer's unhandled-rejection path. Canvas persistence has no browser
  // storage story yet; encryption-key health is meaningless on the web
  // (the sync server holds keys server-side).
  if (ns === 'accounts' && fn === 'checkKeyHealth') return { ok: true };
  if (ns === 'canvas') {
    if (fn === 'loadCurrentSpec') return null;
    if (fn === 'loadHistory') return [];
    if (fn === 'deleteHistoryEntry' || fn === 'updateSpec') return undefined;
  }

  if (ns === 'plaid') {
    if (fn === 'isConfigured') return plaidClient.isConfigured();
    // A core DB read with no Plaid/crypto involvement — see core-bridge.ts's
    // re-export for why this one function is safe to bundle even though the
    // rest of `plaid` is sync-server-backed.
    if (fn === 'getDefaultDaysRequested') return getDefaultDaysRequested();
    if (fn === 'linkBank') return linkBank(args[0] as number | undefined, args[1] as string | undefined);
    if (fn === 'cancelLink') return cancelLink();
    throw new Error(`web bridge: unknown call plaid.${fn}`);
  }

  if (ns === 'sync') {
    if (fn === 'getLastSyncedAt') {
      // A core DB read with no Plaid/crypto involvement — see core-bridge.ts's
      // re-export for why this one function is safe to bundle directly.
      // Accounts.tsx calls this unconditionally on mount, so leaving it
      // unhandled crashed the whole screen via its ErrorBoundary, not just a
      // stubbed feature.
      // The engine's own last completed cycle (ISO string in _sync_state);
      // epoch ms is what the renderer expects. There is no plaid_items table
      // locally, so the old plaid-based value would always read "never".
      const iso = (await getWebSyncInfo()).lastSyncAt;
      const ms = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(ms) ? ms : getLastSyncedAt();
    }
    if (fn === 'syncAll') {
      // Accounts.tsx's signature is (force?, itemIds?). `force` has no
      // per-item debounce to bypass here and is ignored; itemIds matters only
      // for "an empty list means sync nothing" (core/sync.ts's contract).
      // Otherwise: ask the sync server to refresh from Plaid, then one engine cycle
      // (push local edits, pull). The result carries CycleStats under `cycle`.
      const itemIds = args[1] as string[] | undefined;
      if (itemIds && itemIds.length === 0) return [];
      return syncNow({ refreshPlaid: true });
    }
    if (fn === 'getInfo') return getWebSyncInfo();
    // Background cycles report through the connection banner, not a push channel.
    if (fn === 'isSyncing') return false;
    if (fn === 'getStatus') {
      // Desktop's getStatus surfaces failures from a background sync that ran
      // before the renderer mounted (see gui/main/registry.ts's sync-status
      // store). There's no equivalent background process on the web — every
      // sync here is user-triggered and reports its own failure directly
      // through syncAll's return value — so there is never a startup failure
      // to report.
      return [];
    }
    if (fn === 'deleteCursorAndResync') {
      throw new Error(
        "Resetting one connection's sync history isn't supported on the web yet — the sync server has no cursor-reset " +
        'endpoint (see the sync server sync route). Remove and re-add the bank instead.',
      );
    }
    throw new Error(`web bridge: unknown call sync.${fn}`);
  }

  // Every other namespace is core-backed in Electron too (queries,
  // transactions, tags, rules, health, trends, imports, categorize, profile,
  // settings, accounts, plus the not-yet-bundled canvas/sync (apart from
  // getLastSyncedAt above)/config/files) — callCore knows which of those are
  // actually wired up and reports a specific reason for the rest.
  return callCore(ns, fn, args);
}

export function installBridge(): void {
  const bridge: Bridge = { platform: 'web', call, invoke: invokeChannel, on: onChannel };
  window.__bridge = bridge;
  // Same push the Electron main process does (gui/main/refresh-ipc.ts): any
  // core mutation or finished sync cycle that calls notifyChange() refetches.
  onRefresh(() => emit('refresh'));
}
