import { db } from './db.js';

/** Plaid's bounds for the transactions history window (days_requested). */
export const MIN_DAYS_REQUESTED = 30;
export const MAX_DAYS_REQUESTED = 730;

/** Settings key for the user's default Plaid history start date (YYYY-MM-DD). */
export const DEFAULT_START_DATE_KEY = 'plaid_default_start_date';

/** Settings key for the user's monthly pre-tax contributions (401k, HSA, etc.) in dollars. */
export const PRETAX_MONTHLY_KEY = 'pretax_monthly';

/**
 * Settings key for whether backupDb() should also copy the encryption key file
 * into the backup directory. Defaults to off ('false'/unset): bundling the key
 * with the encrypted data it protects defeats the point of encryption for
 * anyone whose backup folder leaves the machine (cloud sync, external drive,
 * NAS). See issue #179 for the tradeoff and core/backup.ts for the consumer.
 */
export const BACKUP_INCLUDE_KEY_KEY = 'backup_include_key';

/**
 * Extra days added on top of the start-date calculation. Plaid's docs don't
 * specify the timezone used to compute the history window, so a small buffer
 * guards against losing the first day to a server/local timezone difference.
 * days_requested is a maximum, so over-requesting is harmless.
 */
export const START_DATE_BUFFER_DAYS = 2;

export async function getSetting(key: string): Promise<string | null> {
  const res = await db.execute({
    sql: 'SELECT value FROM settings WHERE key = ?',
    args: [key],
  });
  const row = res.rows[0] as unknown as { value: string } | undefined;
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/**
 * Days of history to request to cover a YYYY-MM-DD start date: the whole days
 * between it and today, plus START_DATE_BUFFER_DAYS, clamped to Plaid's
 * [MIN_DAYS_REQUESTED, MAX_DAYS_REQUESTED] range. Returns null if the string is
 * not a valid date. The start is anchored at local noon so rounding absorbs
 * today's time-of-day (and any DST hour) without extra normalization.
 */
export function daysFromStartDate(startDate: string, today = new Date()): number | null {
  const start = new Date(`${startDate}T12:00:00`);
  if (isNaN(start.getTime())) return null;
  const days = Math.round((today.getTime() - start.getTime()) / 86_400_000);
  return clamp(days + START_DATE_BUFFER_DAYS, MIN_DAYS_REQUESTED, MAX_DAYS_REQUESTED);
}

/**
 * The default number of days of history to request when linking a bank,
 * derived from the saved default start date. Falls back to MAX_DAYS_REQUESTED
 * when no (valid) start date has been configured.
 */
export async function getDefaultDaysRequested(): Promise<number> {
  const startDate = await getSetting(DEFAULT_START_DATE_KEY);
  if (!startDate) return MAX_DAYS_REQUESTED;
  return daysFromStartDate(startDate) ?? MAX_DAYS_REQUESTED;
}
