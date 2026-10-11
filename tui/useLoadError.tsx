import { useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import { C_NEGATIVE } from './ui.js';

// Surfaces a rejected data load as an error state instead of an unhandled
// rejection (which kills the process) or a misleading empty state. Wrap each
// query as `void track(query()).then(setX)`: on rejection the message is stored
// and a never-settling promise is returned so the chained setter never runs.
export function useLoadError() {
  const [loadError, setLoadError] = useState<string | null>(null);
  const track = useCallback(<T,>(p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setLoadError(`Could not load data - the database may be locked or corrupt. (${detail})`);
      return new Promise<T>(() => {});
    }), []);
  return { loadError, track } as const;
}

export function LoadError({ message }: { message: string }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={C_NEGATIVE} bold>{message}</Text>
    </Box>
  );
}
