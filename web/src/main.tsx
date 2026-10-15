import React from 'react';
import { createRoot } from 'react-dom/client';
import { installBridge } from './bridge.js';
import { initDb } from './core-bridge.js';
import { resumeSession, startSyncSession, setConnState, isSyncConfigured } from './account-client.js';
import { getSyncMode } from '../../core/sync-mode.js';
import { SyncStatusBanner } from './SyncStatusBanner.js';
import { TabLockedScreen, StartupFailedScreen, isTabLockedError } from './BootScreens.js';
// Reused unchanged from the Electron renderer — see the note at the top of
// web/vite.config.ts for how these out-of-root imports are served.
import { App } from '../../gui/renderer/src/App.js';
import '../../gui/renderer/src/styles/theme.css';

installBridge();

const root = createRoot(document.getElementById('root')!);

function renderShell() {
  root.render(
    <React.StrictMode>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <SyncStatusBanner />
        <div style={{ flex: 1, minHeight: 0 }}>
          <App />
        </div>
      </div>
    </React.StrictMode>,
  );
  // Fire and forget: the shell is already on screen, and failures surface in
  // the connection banner rather than blocking or logging the user out. Does
  // nothing unless this install syncs and a session exists.
  void startSyncSession();
}

// Another tab holding the database is never papered over with a throwaway
// in-memory copy (that would silently fork the user's data); only a browser
// that cannot give durable storage at all falls back to memory, and the banner
// says so.
async function openLocalDb(): Promise<void> {
  try {
    await initDb();
  } catch (err) {
    if (isTabLockedError(err)) throw err;
    await initDb({ allowMemoryFallback: true });
  }
}

// The web app starts local-only: the shell always renders from the local
// database. Order: open the DB (the engine's connect step writes to it), then
// a silent resume (only attempted when this browser has logged in before). An
// unreachable server at resume still shows the shell; it is not a logout.
async function boot() {
  try {
    await openLocalDb();
  } catch (err) {
    console.error('initDb() failed:', err);
    root.render(isTabLockedError(err)
      ? <TabLockedScreen />
      : <StartupFailedScreen message={err instanceof Error ? err.message : String(err)} />);
    return;
  }
  // No VITE_FUNGIBLE_SYNC_URL: purely local, no resume attempt, no banner state.
  const resumed = isSyncConfigured() ? await resumeSession() : 'none';
  if (isSyncConfigured() && resumed === 'none' && (await getSyncMode()) === 'hosted') {
    setConnState('error', 'Signed out. Sign in from Settings to resume syncing.');
  }
  renderShell();
}

void boot();
