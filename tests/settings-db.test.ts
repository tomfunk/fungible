import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import {
  getSetting, setSetting, getDefaultDaysRequested,
  DEFAULT_START_DATE_KEY, MAX_DAYS_REQUESTED, PRETAX_MONTHLY_KEY,
} from '../core/settings.js';

describe('getSetting / setSetting', () => {
  it('returns null for an unset key', async () => {
    expect(await getSetting('_missing_key_xyz_')).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await setSetting('_test_roundtrip_', 'hello');
    expect(await getSetting('_test_roundtrip_')).toBe('hello');
  });

  it('upserts — second write replaces the first', async () => {
    await setSetting('_test_upsert_', 'v1');
    await setSetting('_test_upsert_', 'v2');
    expect(await getSetting('_test_upsert_')).toBe('v2');
  });
});

describe('getDefaultDaysRequested', () => {
  it('returns MAX_DAYS_REQUESTED when no start date is set', async () => {
    expect(await getDefaultDaysRequested()).toBe(MAX_DAYS_REQUESTED);
  });

  it('returns MAX_DAYS_REQUESTED for a date farther back than 730 days', async () => {
    await setSetting(DEFAULT_START_DATE_KEY, '2020-01-01');
    expect(await getDefaultDaysRequested()).toBe(MAX_DAYS_REQUESTED);
  });
});

describe('PRETAX_MONTHLY_KEY', () => {
  it('returns null when no pretax contribution is set', async () => {
    expect(await getSetting(PRETAX_MONTHLY_KEY)).toBeNull();
  });

  it('persists independently of other settings keys', async () => {
    await setSetting(PRETAX_MONTHLY_KEY, '350');
    await setSetting(DEFAULT_START_DATE_KEY, '2023-01-01');
    expect(await getSetting(PRETAX_MONTHLY_KEY)).toBe('350');
    expect(await getSetting(DEFAULT_START_DATE_KEY)).toBe('2023-01-01');
  });
});
