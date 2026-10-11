import { useUiPrefs } from '../hooks/useUiPrefs.js';
import styles from './KeyHints.module.css';

/** Dim hint line listing a screen's active keybindings — shown only when the
 *  keys toggle is on, mirroring the TUI's showHints line. */
export function KeyHints({ hints }: { hints: string }) {
  const { keys } = useUiPrefs();
  if (!keys) return null;
  return <p className={styles.hints}>{hints}</p>;
}
