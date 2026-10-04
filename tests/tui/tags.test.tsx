import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Keep householdMembers real (a pure helper used by the owner picker) but stub
// the DB-backed loadProfile/saveProfile. loadProfile is a vi.fn so a test can
// supply a profile whose members populate the cycle.
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { Tags } from '../../tui/Tags.js';
import { waitFor as baseWaitFor, frame, flatFrame, press, pressKeys } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

describe('Tags', () => {
  function tags(overrides?: Partial<Parameters<typeof Tags>[0]>) {
    return render(
      <W>
        <Tags onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('shows seeded tags after load', async () => {
    const r = tags();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('travel');
      expect(f).toContain('work');
    });
  });

  it('a key enters new-tag input mode', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Tag'));
  });

  it('[n] opens rename panel pre-filled with the tag name', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('n');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Rename Tag');
      expect(f).toContain('travel');
    });
  });

  it('typing a suffix and Enter in rename panel renames the tag', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Rename Tag'));
    for (const ch of '-edited') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('travel-edited'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Rename Tag');
      expect(f).toContain('travel-edited');
    });
  });

  it('Esc in rename panel cancels without saving', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Rename Tag'));
    for (const ch of 'xyz') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('travelxyz'));
    r.stdin.write('\x1b');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Rename Tag');
      expect(f).not.toContain('travelxyz');
      expect(f).toContain('travel');
    });
  });

  // A tag rarely represents actual income (e.g. a reimbursement is inflow,
  // not income), so the detail view's KPI labels read as Inflow/Outflow
  // rather than Income/Expenses.
  it('Enter on a tag opens its detail view with Inflow/Outflow KPI labels', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Inflow');
      expect(f).toContain('Outflow');
    });
  });

  // Regression: the category breakdown intentionally NETS a refund against its
  // category's spending (e.g. Amtrak $300 charge + $100 refund shows as $200
  // Travel spend), but the headline Inflow/Outflow KPIs must stay gross — a
  // reimbursement should show up as Inflow, not silently reduce Outflow.
  it('Inflow/Outflow KPIs are gross, not netted within a category', async () => {
    await db.batch([
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-amtrak-charge', 'test-credit', '2026-05-05', 'Amtrak',        300.00, 'Travel', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-amtrak-refund', 'test-credit', '2026-05-06', 'Amtrak Refund', -100.00, 'Travel', 0, 0)`,
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx-amtrak-charge', 1)`,
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx-amtrak-refund', 1)`,
    ], 'write');

    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Inflow'));

    const f = frame(r);
    // Gross: Outflow $300.00 (not netted down to $200.00), Inflow $100.00.
    expect(f).toContain('300.00');
    expect(f).toContain('100.00');
  });

  it('[x] deletes the selected tag and its transaction_tags rows, leaving other tags alone', async () => {
    await db.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx-groc-1', 1), ('tx-dining-1', 2)");
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    await press(r, 'x');
    await waitFor(() => expect(flatFrame(r)).toContain('Deleted "travel"'));
    await waitFor(async () => expect((await db.execute('SELECT name FROM tags ORDER BY name')).rows.map((x) => x.name)).toEqual(['work']));
    const tt = (await db.execute('SELECT transaction_id, tag_id FROM transaction_tags')).rows;
    expect(tt.map((x) => [x.transaction_id, Number(x.tag_id)])).toEqual([['tx-dining-1', 2]]);
    expect(frame(r)).toContain('work');
    expect(frame(r)).not.toMatch(/travel\s+\d+ tx/); // the status line still names it; the row is gone
  });

  it('[a] creates a tag from the typed name: row written and listed', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    await press(r, 'a');
    await waitFor(() => expect(frame(r)).toContain('New Tag'));
    await pressKeys(r, [...'newtag']);
    await press(r, '\r');
    await waitFor(async () => expect((await db.execute("SELECT name FROM tags WHERE name = 'newtag'")).rows).toHaveLength(1));
    await waitFor(() => expect(frame(r)).toContain('newtag'));
    expect(flatFrame(r)).toContain('3 tags');
  });

  it.each([['empty', ''], ['whitespace-only', '   ']])('[a] with an %s name does not create a tag and stays in add mode', async (_label, typed) => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    await press(r, 'a');
    await waitFor(() => expect(frame(r)).toContain('New Tag'));
    await pressKeys(r, [...typed]);
    await press(r, '\r');
    await new Promise((res) => setTimeout(res, 100));
    expect(frame(r)).toContain('New Tag');
    expect((await db.execute('SELECT name FROM tags ORDER BY name')).rows.map((x) => x.name)).toEqual(['travel', 'work']);
  });

  it('[n] with the name cleared then Enter leaves the name unchanged', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    await press(r, 'n');
    await waitFor(() => expect(frame(r)).toContain('Rename Tag'));
    await pressKeys(r, Array(10).fill('\x7f')); // backspace over the prefilled name
    await press(r, '\r');
    await new Promise((res) => setTimeout(res, 100));
    expect(frame(r)).toContain('Rename Tag');
    expect((await db.execute('SELECT name FROM tags ORDER BY name')).rows.map((x) => x.name)).toEqual(['travel', 'work']);
  });
});
