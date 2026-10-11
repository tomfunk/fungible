import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Pins `Date` (only Date — timers stay real, so waitFor-style polling and
 * setTimeout still work) for the enclosing describe/file. Registers its own
 * beforeEach/afterEach, so call it at describe or module top level, not
 * inside an `it`. Restores real timers automatically.
 *
 * Default instant is mid-day UTC so local-time and UTC calendar dates agree in
 * every timezone from UTC-11 to UTC+11.
 */
export const FIXED_NOW_ISO = '2026-10-02T12:00:00Z';

export function useFixedClock(iso: string = FIXED_NOW_ISO): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
