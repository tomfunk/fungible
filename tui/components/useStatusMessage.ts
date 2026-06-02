import { useState, useCallback } from 'react';

/** Replaces the setStatusMsg + setTimeout(clear) pattern. */
export function useStatusMessage(defaultDuration = 2000) {
  const [statusMsg, setStatusMsg] = useState('');
  const showStatus = useCallback((msg: string, ms = defaultDuration) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(''), ms);
  }, [defaultDuration]);
  return { statusMsg, showStatus };
}
