// Same ambient declaration as gui/renderer/src/env.d.ts, duplicated rather
// than shared because it lives outside this project's tsconfig `include` and
// ambient .d.ts files aren't picked up transitively through imports. Keep in
// sync with that file if the Bridge shape changes.
import type { Bridge } from '../../gui/shared/api-types.js';

declare global {
  interface Window {
    __bridge: Bridge;
  }
}

export {};
