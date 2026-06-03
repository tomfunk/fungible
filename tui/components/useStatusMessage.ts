import { useState, useCallback, useRef, useEffect } from 'react';

/** Replaces the setStatusMsg + setTimeout(clear) pattern. */
export function useStatusMessage(defaultDuration = 2000) {
  const [statusMsg, setStatusMsg] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const showStatus = useCallback((msg: string, ms = defaultDuration) => {
    clearTimeout(timerRef.current);
    setStatusMsg(msg);
    timerRef.current = setTimeout(() => setStatusMsg(''), ms);
  }, [defaultDuration]);

  return { statusMsg, showStatus };
}
