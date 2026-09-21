import React from 'react';
import type { Screen } from '../../../shared/nav.js';
import { SCREEN_LABELS, SCREEN_ORDER, SCREEN_DIGITS } from '../../../shared/nav.js';
import { useUiPrefs } from '../hooks/useUiPrefs.js';
import styles from './SideNav.module.css';

export function SideNav({
  active,
  onSelect,
}: {
  active: Screen;
  onSelect: (s: Screen) => void;
}) {
  const { theme, toggleTheme, keys, toggleKeys } = useUiPrefs();

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

      <div className={styles.footer}>
        <button
          className={styles.toggle}
          onClick={toggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? 'Dark' : 'Light'}
        </button>
        <button
          className={keys ? styles.toggleActive : styles.toggle}
          onClick={toggleKeys}
          title="TUI-style keybindings: 0-9 navigate, plus per-screen keys shown as hints"
        >
          Keys
        </button>
      </div>
    </nav>
  );
}
