import React from 'react';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { registry } from '../../../gui/main/registry.js';
import { RefreshProvider } from '../../../gui/renderer/src/hooks/useRefresh.js';
import { FilterProvider } from '../../../gui/renderer/src/hooks/useFilter.js';
import { UiPrefsProvider } from '../../../gui/renderer/src/hooks/useUiPrefs.js';
import { NavContext } from '../../../gui/renderer/src/hooks/useNav.js';
import type { Screen, TxFilter } from '../../../gui/shared/nav.js';
import type { Filter } from '../../../core/filters.js';

// Electron-side bridge namespaces (gui/main/bridge.ts) stubbed for tests.
const STUBS: Record<string, Record<string, (...args: unknown[]) => unknown>> = {
  plaid: {
    isConfigured: async () => false,
    getDefaultDaysRequested: async () => 730,
    linkBank: async () => {
      throw new Error('plaid link not available in tests');
    },
    cancelLink: async () => {},
  },
  files: { pickCsv: async () => null },
};

export type BridgeHarness = {
  /** Push an event to subscribers of an `on` channel (e.g. a sync-status update). */
  emit: (channel: string, ...args: unknown[]) => void;
  /** Register a handler for an `invoke` channel (the dedicated IPC channels that
   *  bypass the registry, e.g. 'sync:refresh'). */
  onInvoke: (channel: string, handler: (...args: unknown[]) => unknown) => void;
};

/** Installs a fake window.__bridge that routes calls into the real registry
 *  (backed by the mocked in-memory DB). Call in beforeEach, before rendering. */
export function installBridge(): BridgeHarness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();
  (window as unknown as { __bridge: unknown }).__bridge = {
    call: async (ns: string, fn: string, args: unknown[]) => {
      const f =
        (registry as unknown as Record<string, Record<string, unknown>>)[ns]?.[fn] ?? STUBS[ns]?.[fn];
      if (typeof f !== 'function') throw new Error(`Unknown bridge call: ${ns}.${fn}`);
      return f(...args);
    },
    invoke: async (channel: string, ...args: unknown[]) => {
      if (invokeHandlers.has(channel)) return invokeHandlers.get(channel)!(...args);
      return channel === 'agent:provider' ? null : undefined;
    },
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(cb);
      return () => {
        listeners.get(channel)!.delete(cb);
      };
    },
  };
  return {
    emit: (channel, ...args) => listeners.get(channel)?.forEach((cb) => cb(...args)),
    onInvoke: (channel, handler) => invokeHandlers.set(channel, handler),
  };
}

// Anchors Dashboard/Trends to the seeded May 2026 data regardless of real date.
export const MAY_FILTER: TxFilter = { range: 'month', anchor: '2026-05-15' };

export function Providers({
  children,
  screen = 'dashboard',
  txFilter = {},
  initialFilter,
  navigate = vi.fn(),
}: {
  children: React.ReactNode;
  screen?: Screen;
  txFilter?: TxFilter;
  initialFilter?: Filter;
  navigate?: (s: Screen, f?: TxFilter) => void;
}) {
  return (
    <RefreshProvider>
      <FilterProvider initial={initialFilter}>
        <UiPrefsProvider>
          <NavContext.Provider value={{ screen, txFilter, navigate }}>{children}</NavContext.Provider>
        </UiPrefsProvider>
      </FilterProvider>
    </RefreshProvider>
  );
}

/** Render a single screen inside all app providers, with a controllable
 *  txFilter (nav payload), an optional initial shared filter, and a spyable
 *  navigate. */
export function renderScreen(
  ui: React.ReactElement,
  opts: {
    screen?: Screen;
    txFilter?: TxFilter;
    initialFilter?: Filter;
    navigate?: (s: Screen, f?: TxFilter) => void;
  } = {},
) {
  return render(
    <Providers screen={opts.screen} txFilter={opts.txFilter} initialFilter={opts.initialFilter} navigate={opts.navigate}>
      {ui}
    </Providers>,
  );
}
