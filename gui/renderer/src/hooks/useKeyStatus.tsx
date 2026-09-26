import React from 'react';
import { api } from '../api.js';
import type { KeyHealth } from '../../../../core/key-health.js';
import { createLiveContext } from './createLiveContext.js';

const DEFAULT_HEALTH: KeyHealth = { ok: true };

// Pulled once on mount — unlike sync status, key state doesn't change
// mid-session except via explicit user action (restoring/replacing the key
// file), so there's nothing to poll or subscribe to.
const keyStatusCtx = createLiveContext<KeyHealth>(DEFAULT_HEALTH, (setValue) => {
  void api.accounts.checkKeyHealth().then(setValue);
});

export function KeyStatusProvider({ children }: { children: React.ReactNode }) {
  return <keyStatusCtx.Provider>{children}</keyStatusCtx.Provider>;
}

export function useKeyStatus(): KeyHealth {
  return keyStatusCtx.useValue();
}
