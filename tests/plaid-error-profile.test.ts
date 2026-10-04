import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { plaidErrorMessage } from '../core/plaid.js';
import { saveProfile, loadProfile, householdMembers, type Profile } from '../core/profile.js';

describe('plaidErrorMessage', () => {
  const axiosErr = (data: Record<string, string>) =>
    Object.assign(new Error('Request failed with status code 400'), { response: { data } });

  it('prefers display_message from an axios-shaped error', () => {
    expect(plaidErrorMessage(axiosErr({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'dev msg', display_message: 'Please log in again' })))
      .toBe('Please log in again');
  });

  it('falls back to "CODE: message" when there is no display_message', () => {
    expect(plaidErrorMessage(axiosErr({ error_code: 'INVALID_REQUEST', error_message: 'bad field' })))
      .toBe('INVALID_REQUEST: bad field');
  });

  it('falls back to "CODE: message" when display_message is empty/null', () => {
    expect(plaidErrorMessage(axiosErr({ error_code: 'X', error_message: 'm', display_message: '' }))).toBe('X: m');
    expect(plaidErrorMessage(axiosErr({ error_code: 'X', error_message: 'm', display_message: null as unknown as string }))).toBe('X: m');
  });

  it('ignores response.data without an error_code and uses the Error message', () => {
    expect(plaidErrorMessage(axiosErr({ error_message: 'orphan' }))).toBe('Request failed with status code 400');
  });

  it('plain Error returns its message; string returns itself', () => {
    expect(plaidErrorMessage(new Error('plain'))).toBe('plain');
    expect(plaidErrorMessage('just a string')).toBe('just a string');
  });

  it('null and undefined do not throw', () => {
    expect(plaidErrorMessage(null)).toBe('null');
    expect(plaidErrorMessage(undefined)).toBe('undefined');
  });
});

describe('saveProfile / loadProfile', () => {
  beforeEach(async () => { await db.execute('DELETE FROM household_members'); });

  const full: Profile = {
    self: { name: 'Thomas', birthYear: 1985 },
    spouse: { name: 'Alex', birthYear: 1987 },
    children: [
      { name: 'A', birthYear: 2020 },
      { name: 'B', birthYear: 2022 },
      { name: 'C', birthYear: 2024 },
    ],
  };
  const ids = async () => (await db.execute('SELECT id FROM household_members ORDER BY sort_order')).rows.map((r) => String(r.id));

  it('empty table loads null', async () => {
    expect(await loadProfile()).toBeNull();
  });

  it('round-trips self, spouse and three children in order', async () => {
    await saveProfile(full);
    expect(await loadProfile()).toEqual(full);
    expect(await ids()).toEqual(['self', 'spouse', 'child-0', 'child-1', 'child-2']);
  });

  it('saving twice is idempotent', async () => {
    await saveProfile(full);
    await saveProfile(full);
    expect(await loadProfile()).toEqual(full);
  });

  it('removing the spouse deletes the row', async () => {
    await saveProfile(full);
    await saveProfile({ ...full, spouse: undefined });
    const p = await loadProfile();
    expect(p?.spouse).toBeUndefined();
    expect(await ids()).not.toContain('spouse');
    expect(p?.children).toHaveLength(3);
  });

  it('reducing three children to one leaves only child-0', async () => {
    await saveProfile(full);
    await saveProfile({ ...full, children: [{ name: 'Z', birthYear: 2019 }] });
    expect(await ids()).toEqual(['self', 'spouse', 'child-0']);
    expect((await loadProfile())?.children).toEqual([{ name: 'Z', birthYear: 2019 }]);
  });

  it('missing self row loads null even when other members exist', async () => {
    await saveProfile(full);
    await db.execute("DELETE FROM household_members WHERE id = 'self'");
    expect(await loadProfile()).toBeNull();
  });
});

describe('householdMembers', () => {
  it('null profile gives an empty list', () => {
    expect(householdMembers(null)).toEqual([]);
  });

  it('trims names and omits blanks, in self/spouse/children order', () => {
    expect(householdMembers({
      self: { name: '  Thomas ', birthYear: 1 },
      spouse: { name: '   ', birthYear: 2 },
      children: [{ name: '', birthYear: 3 }, { name: ' Kid ', birthYear: 4 }],
    })).toEqual(['Thomas', 'Kid']);
  });

  it('blank self is omitted but spouse is kept', () => {
    expect(householdMembers({ self: { name: '', birthYear: 1 }, spouse: { name: 'Alex', birthYear: 2 }, children: [] })).toEqual(['Alex']);
  });
});
