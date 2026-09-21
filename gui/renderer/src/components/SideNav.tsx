import React, { useEffect, useState } from 'react';
import type { Screen } from '../../../shared/nav.js';
import { SCREEN_LABELS, SCREEN_ORDER, SCREEN_DIGITS } from '../../../shared/nav.js';
import { useUiPrefs } from '../hooks/useUiPrefs.js';
import { api } from '../api.js';
import styles from './SideNav.module.css';

export function SideNav({
  active,
  onSelect,
}: {
  active: Screen;
  onSelect: (s: Screen) => void;
}) {
  const { keys } = useUiPrefs();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void api.app.getVersion().then(setVersion);
  }, []);

  return (
    <nav className={styles.nav}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>●</span> fungible
      </div>
      {SCREEN_ORDER.map((s) => (
        <button
          key={s}
          className={s === active ? styles.itemActive : styles.item}
          onClick={() => onSelect(s)}
        >
          <span>{SCREEN_LABELS[s]}</span>
          {keys && <span className={styles.digit}>{SCREEN_DIGITS[s]}</span>}
        </button>
      ))}
      {version && <div className={styles.version}>v{version}</div>}
    </nav>
  );
}
