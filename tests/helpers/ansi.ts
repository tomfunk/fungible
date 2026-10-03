import chalk from 'chalk';
import { afterEach, beforeEach } from 'vitest';

/** SGR open sequences for chalk's named colours at level 1 (16 colours). */
export const SGR = {
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
} as const;

/**
 * Forces chalk (shared with Ink) to emit 16-colour ANSI for the enclosing
 * describe/file, restoring the previous level afterwards. Call at describe or
 * module top level, before rendering. Ink-testing-library output is otherwise
 * colourless (no TTY), so colour assertions need this.
 */
export function useForcedColor(level: 1 | 2 | 3 = 1): void {
  let prev: number;
  beforeEach(() => { prev = chalk.level; chalk.level = level; });
  afterEach(() => { chalk.level = prev as typeof chalk.level; });
}

/**
 * True if `text` appears in `frame` directly preceded by `sgr` (e.g. SGR.yellow)
 * with the same styled run: i.e. `<sgr>...text`, with only other escape codes
 * or text of the same run in between. Assumes useForcedColor() is active.
 * Theme defaults: C_WARNING = yellow, C_NEGATIVE = red, C_POSITIVE = green.
 */
export function frameHasColor(frame: string | undefined, text: string, sgr: string): boolean {
  if (!frame) return false;
  const close = '\x1b[39m';
  let from = 0;
  for (;;) {
    const open = frame.indexOf(sgr, from);
    if (open === -1) return false;
    const end = frame.indexOf(close, open);
    const run = frame.slice(open + sgr.length, end === -1 ? undefined : end);
    if (run.includes(text)) return true;
    from = open + sgr.length;
  }
}
