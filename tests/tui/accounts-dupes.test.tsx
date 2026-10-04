import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { Accounts } from '../../tui/Accounts.js';
import { waitFor as baseWaitFor, flatFrame, press, pressKeys } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { seedTx } from '../helpers/seedDb.js';
import { W, noop, useEmptyScreenDb } from './helpers/screenSetup.js';

useEmptyScreenDb();

async function seedPair(n: number, opts: { csvExtra?: Parameters<typeof seedTx>[1] } = {}) {
  const csv = await seedTx(db, { id: `csv-${n}`, account_id: 'a1', date: '2026-05-10', name: `Merchant ${n}`, amount: 20 + n, source: 'csv', category: 'Shopping', ...opts.csvExtra });
  const plaid = await seedTx(db, { id: `plaid-${n}`, account_id: 'a1', date: '2026-05-11', name: `Merchant ${n}`, amount: 20 + n, source: 'plaid', category: 'Shopping' });
  return { csv, plaid };
}

async function openDupes() {
  const r = render(<W><Accounts onNavigate={noop} showHints={false} /></W>);
  await waitFor(() => expect(flatFrame(r)).toContain('Dupes'));
  await pressKeys(r, ['\t', '\t', '\t']);
  return r;
}
const ids = async () => (await db.execute('SELECT id FROM transactions ORDER BY id')).rows.map((x) => x.id);

describe('Accounts > Dupes', () => {
  it('[x] deletes the CSV row, keeps the Plaid row and transfers the CSV row\'s edits', async () => {
    await db.execute("INSERT INTO accounts (id, name, type) VALUES ('a1', 'Checking', 'depository')");
    await db.execute("INSERT INTO tags (id, name) VALUES (1, 'trip')");
    await seedPair(1, { csvExtra: { manual_category: 'Dining', display_name: 'My Label' } });
    await db.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-1', 1)");
    const r = await openDupes();
    await waitFor(() => expect(flatFrame(r)).toContain('Merchant 1'));
    await press(r, 'x');
    await waitFor(async () => expect(await ids()).toEqual(['plaid-1']));
    await waitFor(() => expect(flatFrame(r)).toContain('No duplicate candidates found.'));
    const p = (await db.execute("SELECT category, manual_category, display_name FROM transactions WHERE id = 'plaid-1'")).rows[0];
    expect(p.manual_category).toBe('Dining');
    expect(p.category).toBe('Dining');
    expect(p.display_name).toBe('My Label');
    const tags = (await db.execute('SELECT transaction_id, tag_id FROM transaction_tags')).rows;
    expect(tags.map((t) => [t.transaction_id, Number(t.tag_id)])).toEqual([['plaid-1', 1]]);
  });

  it('[X] deletes every listed CSV row at once (no confirmation today) and keeps the Plaid rows', async () => {
    // NOTE: there is no confirm step before the bulk delete; this test documents the current behaviour.
    await db.execute("INSERT INTO accounts (id, name, type) VALUES ('a1', 'Checking', 'depository')");
    await seedPair(1);
    await seedPair(2);
    const r = await openDupes();
    await waitFor(() => expect(flatFrame(r)).toContain('Merchant 2'));
    await press(r, 'X');
    await waitFor(async () => expect(await ids()).toEqual(['plaid-1', 'plaid-2']));
    await waitFor(() => expect(flatFrame(r)).toContain('No duplicate candidates found.'));
  });
});
