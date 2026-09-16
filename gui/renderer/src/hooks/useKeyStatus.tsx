import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import type { KeyHealth } from '../../../../core/key-health.js';

const DEFAULT_HEALTH: KeyHealth = { ok: true };

const KeyStatusContext = createContext<KeyHealth>(DEFAULT_HEALTH);

export function KeyStatusProvider({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<KeyHealth>(DEFAULT_HEALTH);
  useEffect(() => {
    // Pulled once on mount — unlike sync status, key state doesn't change
    // mid-session except via explicit user action (restoring/replacing the key
    // file), so there's nothing to poll or subscribe to.
    void api.accounts.checkKeyHealth().then(setHealth);
  }, []);
  return <KeyStatusContext.Provider value={health}>{children}</KeyStatusContext.Provider>;
}

export function useKeyStatus(): KeyHealth {
  return useContext(KeyStatusContext);
}
