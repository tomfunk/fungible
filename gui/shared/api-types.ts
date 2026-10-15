import type { fullRegistry } from '../main/bridge.js';

type AsyncFn<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

export type RendererApi = {
  [N in keyof typeof fullRegistry]: {
    [K in keyof (typeof fullRegistry)[N]]: AsyncFn<(typeof fullRegistry)[N][K]>;
  };
};

export type Bridge = {
  /** Set by the web build only. Absent on desktop. */
  platform?: 'web';
  call: (ns: string, fn: string, args: unknown[]) => Promise<unknown>;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
};
