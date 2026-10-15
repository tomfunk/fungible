import React, { useEffect, useState } from 'react';
import { subscribeConnState, getConnDetail, type ConnState } from './account-client.js';
import { isDbPersistent } from './local-data.js';
import styles from './SyncStatusBanner.module.css';

/**
 * Mounted once in main.tsx beside <App />. Persistent, self-healing banner:
 * 'unreachable' (network failure or 5xx) and 'error' (a sync cycle failed for
 * another reason) are shown here and neither signs the user out. Also warns
 * when the browser could not give the app durable storage.
 */
export function SyncStatusBanner() {
  const [state, setState] = useState<ConnState>('ok');
  useEffect(() => subscribeConnState(setState), []);
  const ephemeral = !isDbPersistent();

  return (
    <>
      {ephemeral && (
        <div className={styles.banner} role="status">
          This browser isn&rsquo;t keeping your data between visits. What you enter here is lost when you close the tab.
        </div>
      )}
      {state === 'unreachable' && (
        <div className={styles.banner} role="status">
          Can&rsquo;t reach the server right now. Your changes are kept and will sync when it is back.
        </div>
      )}
      {state === 'error' && (
        <div className={styles.banner} role="status">Sync problem: {getConnDetail() ?? 'something went wrong'}</div>
      )}
    </>
  );
}
