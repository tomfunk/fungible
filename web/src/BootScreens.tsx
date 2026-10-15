import React from 'react';
import styles from './LoginScreen.module.css';

/** Shown when core/db.browser.ts reports the OPFS database is held by another tab. */
export function TabLockedScreen() {
  return (
    <div className={styles.screen}>
      <section className={styles.panel}>
        <h1 className={styles.title}>fungible is open in another tab</h1>
        <p className="dim">
          Your data can only be used by one tab at a time. Switch to the tab that is already open, or close it and
          reload this one.
        </p>
        <div className={styles.actions}>
          <button className={styles.btnPrimary} type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </section>
    </div>
  );
}

export function StartupFailedScreen({ message }: { message: string }) {
  return (
    <div className={styles.screen}>
      <section className={styles.panel}>
        <h1 className={styles.title}>Couldn&rsquo;t start</h1>
        <p className="dim">The local database failed to open.</p>
        <p className={styles.error}>{message}</p>
        <div className={styles.actions}>
          <button className={styles.btnPrimary} type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </section>
    </div>
  );
}

export function isTabLockedError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: unknown }).code === 'OPFS_LOCKED';
}
