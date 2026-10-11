import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './useStatus.module.css';

/** Toast-style status message, analog of the TUI's useStatusMessage. */
export function useStatus() {
  const [statusMsg, setStatusMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const mounted = useRef(true);

  // Clear the pending toast timer on unmount so it can't fire (and set state)
  // after the component or the DOM environment is gone.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const showStatus = useCallback((msg: string, duration = 2000) => {
    if (!mounted.current) return;
    setStatusMsg(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatusMsg(''), duration);
  }, []);

  const statusEl = statusMsg ? <div className={styles.toast}>{statusMsg}</div> : null;
  return { showStatus, statusEl };
}
