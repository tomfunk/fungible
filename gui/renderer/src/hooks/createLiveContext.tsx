import React, { createContext, useContext, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Shared scaffolding behind useRefresh/useSyncStatus/useKeyStatus: a value
 * seeded with `initial`, provided via context, populated by whatever
 * `setup` does with the state setter it's handed (an initial fetch, a
 * window.__bridge.on() subscription, both, or neither) — each hook supplies
 * its own `setup` verbatim from its pre-merge effect body, so this only
 * factors out the repeated createContext/Provider/useContext wiring, never
 * the differing fetch/subscribe semantics themselves.
 *
 * `setup` runs once on mount (deps: []), matching every pre-merge effect —
 * none of the three ever re-ran their setup after mount.
 */
export function createLiveContext<T>(
  initial: T,
  setup: (setValue: Dispatch<SetStateAction<T>>) => void | (() => void),
) {
  const Context = createContext<{ value: T; setValue: Dispatch<SetStateAction<T>> }>({
    value: initial,
    setValue: () => {},
  });

  function Provider({ children }: { children: React.ReactNode }) {
    const [value, setValue] = useState<T>(initial);
    useEffect(() => setup(setValue), []); // eslint-disable-line react-hooks/exhaustive-deps
    return <Context.Provider value={{ value, setValue }}>{children}</Context.Provider>;
  }

  function useValue(): T {
    return useContext(Context).value;
  }

  // setValue from useState is referentially stable for the life of the
  // Provider, so a caller wrapping this in its own useCallback (e.g.
  // useBumpRefresh) gets a stable callback too, same as the pre-merge code.
  function useSetValue(): Dispatch<SetStateAction<T>> {
    return useContext(Context).setValue;
  }

  return { Provider, useValue, useSetValue };
}
