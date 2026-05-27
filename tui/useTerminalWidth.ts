import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(() => stdout.columns ?? 80);
  useEffect(() => {
    const update = () => setWidth(stdout.columns ?? 80);
    stdout.on('resize', update);
    return () => { stdout.off('resize', update); };
  }, [stdout]);
  return width;
}
