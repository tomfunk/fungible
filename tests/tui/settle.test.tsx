import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { loadProfile } from '../../core/profile.js';
import * as splitApi from '../../core/split.js';
import { setupSplit, getSplitConfig } from '../../core/split.js';
import { getOrCreateTag, addTagToTransactions } from '../../core/tags.js';
import { Settle } from '../../tui/Settle.js';
import { FilterProvider } from '../../tui/FilterContext.js';
import { waitFor as baseWaitFor, frame, press, pressKeys } from '../helpers/waitFor.js';
import { useFixedClock } from '../helpers/fakeClock.js';
import { failDb } from '../helpers/failingDb.js';
import { W, MAY_FILTER, noop, useSeededScreenDb } from './helpers/screenSetup.js';

const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ESC = '\u001b';

useSeededScreenDb();
// June 10, 2026: May is a finished month, June is in progress.
useFixedClock('2026-06-10T12:00:00Z');

const HOUSEHOLD = { self: { name: 'Pat', birthYear: 1985 }, spouse: { name: 'Alex', birthYear: 1986 }, children: [] };

async function household() {
  vi.mocked(loadProfile).mockResolvedValue(HOUSEHOLD);
  // Seeded: test-credit carries the May expenses; test-checking holds the income.
  await db.execute("UPDATE accounts SET owner = 'Pat' WHERE id = 'test-credit'");
  await db.execute("UPDATE accounts SET owner = 'Alex' WHERE id = 'test-checking'");
}

async function tagged(tagName: string, ids: string[]) {
  await addTagToTransactions(ids, await getOrCreateTag(tagName));
}

/** May: Pat paid $120 (Whole Foods), Alex paid $200 → Alex owes Pat $48, Pat owes Alex $120, Pat pays Alex $72. */
async function configuredMay() {
  await household();
  await setupSplit({ jointTagName: 'joint', settledTagName: 'settled', selfPct: 60, startDate: '2026-05-01' });
  await db.execute(`INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
    VALUES ('tx-alex-rent', 'test-checking', '2026-05-20', 'Landlord', 200, 'Rent', 0, 0)`);
  await tagged('joint', ['tx-groc-1', 'tx-alex-rent']);
}

async function tagsOn(txId: string): Promise<string[]> {
  const r = await db.execute({
    sql: 'SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ? ORDER BY tg.name',
    args: [txId],
  });
  return r.rows.map((x) => String(x.name));
}

function settle(overrides?: Partial<Parameters<typeof Settle>[0]>) {
  return render(
    <W>
      <FilterProvider>
        <Settle onNavigate={noop} showHints={false} initialFilter={MAY_FILTER} {...overrides} />
      </FilterProvider>
    </W>,
  );
}

describe('Settle up', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks for both household names before anything else', async () => {
    const r = settle();
    await waitFor(() => expect(frame(r)).toContain("needs your name and your spouse's name"));
  });

  describe('setup', () => {
    it('opens setup when the split is not configured, and saves it', async () => {
      await household();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Set up expense splitting'));
      expect(frame(r)).toContain('joint');
      expect(frame(r)).toContain('2026-06-01'); // start defaults to the 1st of this month
      expect(frame(r)).toContain('Personal tag');
      await pressKeys(r, [DOWN, DOWN, DOWN]);
      await press(r, '6');
      await press(r, '0');
      await press(r, '\r');
      await waitFor(() => expect(frame(r)).toContain('Pat 60% / Alex 40% from 2026-06-01'));
      expect((await getSplitConfig()).status).toBe('ready');
    });

    it('shows a validation error inline and stays in setup', async () => {
      await household();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Set up expense splitting'));
      await press(r, '\r'); // percentage left empty
      await waitFor(() => expect(frame(r)).toContain('Percentage must be between 0 and 100'));
      expect((await getSplitConfig()).status).toBe('unconfigured');
    });

    it('warns once when the settled tag is already on transactions, then proceeds', async () => {
      await household();
      await tagged('settled', ['tx-dining-1']); // May 9, before the default June 1 start
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Set up expense splitting'));
      await pressKeys(r, [DOWN, DOWN, DOWN, '5', '0']);
      await press(r, '\r');
      await waitFor(() => expect(frame(r)).toContain('1 transaction already carries "settled"'));
      expect((await getSplitConfig()).status).toBe('unconfigured');
      await press(r, '\r');
      await waitFor(() => expect(frame(r)).toContain('Pat 50% / Alex 50%'));
    });
  });

  describe('months', () => {
    it('lists each month and opens on the Dashboard month, showing who owes whom', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Jun 2026');
        expect(f).toContain('MAY 2026');
        expect(f).toContain('Alex owes Pat');
        expect(f).toContain('40% of $120.00  =  $48.00');
        expect(f).toContain('Pat owes Alex');
        expect(f).toContain('60% of $200.00  =  $120.00');
        expect(f).toContain('Pat pays Alex $72.00');
      });
    });

    it('settles a month after confirming, tagging its joint transactions', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Pat pays Alex $72.00'));
      await press(r, 's');
      await waitFor(() => expect(frame(r)).toContain('Settle May 2026'));
      await press(r, 'y');
      await waitFor(() => expect(frame(r)).toContain('Settled May 2026'));
      expect(await tagsOn('tx-groc-1')).toEqual(['joint', 'settled']);
      expect(await tagsOn('tx-alex-rent')).toEqual(['joint', 'settled']);
      expect(await tagsOn('tx-groc-2')).toEqual([]); // not joint, so not settled
    });

    it('cancels the confirmation without writing', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Pat pays Alex $72.00'));
      await press(r, 's');
      await waitFor(() => expect(frame(r)).toContain('Settle May 2026'));
      await press(r, 'n');
      await waitFor(() => expect(frame(r)).not.toContain('Settle May 2026'));
      expect(await tagsOn('tx-groc-1')).toEqual(['joint']);
    });

    it('shows a late transaction in a settled month as a top-up', async () => {
      await configuredMay();
      await tagged('settled', ['tx-groc-1', 'tx-alex-rent']);
      await tagged('joint', ['tx-dining-1']); // Pat's $45, after settling
      const r = settle();
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('top-up');
        expect(f).toContain('Already settled');
        expect(f).toContain('Pat paid Alex $72.00');
        expect(f).toContain('Alex pays Pat $18.00'); // 40% of $45
      });
    });

    it('blocks settling when a joint expense is on an account nobody owns', async () => {
      await configuredMay();
      await db.execute("UPDATE accounts SET owner = NULL WHERE id = 'test-checking'");
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('blocked'));
      await press(r, 's');
      await waitFor(() => expect(frame(r)).toContain("Can't settle May 2026"));
      expect(frame(r)).not.toContain('[y] settle');
      expect(await tagsOn('tx-groc-1')).toEqual(['joint']);
    });

    it('warns about pending transactions and an unfinished month but still settles', async () => {
      await configuredMay();
      await db.execute(`INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
        VALUES ('tx-june', 'test-credit', '2026-06-05', 'Grocer', 50, 'Grocery', 0, 0),
               ('tx-june-pending', 'test-credit', '2026-06-08', 'Grocer', 30, 'Grocery', 1, 0)`);
      await tagged('joint', ['tx-june', 'tx-june-pending']);
      const r = settle({ initialFilter: { range: 'month', anchor: '2026-06-01' } });
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain("June isn't over yet");
        expect(f).toContain('1 joint transaction still pending');
      });
      await press(r, 's');
      await waitFor(() => expect(frame(r)).toContain('Settle June 2026'));
      await press(r, 'y');
      await waitFor(() => expect(frame(r)).toContain('Settled June 2026'));
      expect(await tagsOn('tx-june')).toEqual(['joint', 'settled']);
      expect(await tagsOn('tx-june-pending')).toEqual(['joint']);
    });

    it('unsettles a month after confirming', async () => {
      await configuredMay();
      await tagged('settled', ['tx-groc-1', 'tx-alex-rent']);
      const r = settle();
      await waitFor(() => expect(frame(r)).toMatch(/May 2026.*settled/));
      await press(r, 'u');
      await waitFor(() => expect(frame(r)).toContain('Unsettle May 2026'));
      await press(r, 'y');
      await waitFor(() => expect(frame(r)).toContain('Unsettled May 2026'));
      expect(await tagsOn('tx-groc-1')).toEqual(['joint']);
    });

    it('settles once even if y is pressed again while the write is in flight', async () => {
      await configuredMay();
      const real = splitApi.settleMonth;
      const spy = vi.spyOn(splitApi, 'settleMonth').mockImplementation(
        (...args) => new Promise<void>((res) => setTimeout(res, 60)).then(() => real(...args)),
      );
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Pat pays Alex $72.00'));
      await press(r, 's');
      await waitFor(() => expect(frame(r)).toContain('Settle May 2026'));
      await pressKeys(r, ['y', 'y']);
      // The list reloads only after the write lands, so it shows the settled state.
      await waitFor(() => expect(frame(r)).toContain('Settled May 2026'));
      await waitFor(() => expect(frame(r)).toMatch(/May 2026.*settled/));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('shows a failed write inline and leaves the month unsettled', async () => {
      await configuredMay();
      vi.spyOn(splitApi, 'settleMonth').mockRejectedValue(new Error('database is locked'));
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Pat pays Alex $72.00'));
      await pressKeys(r, ['s', 'y']);
      await waitFor(() => expect(frame(r)).toContain('Could not settle May 2026: database is locked'));
      expect(await tagsOn('tx-groc-1')).toEqual(['joint']);
    });

    it('shows a load error instead of an empty list when the database fails', async () => {
      await configuredMay();
      const restore = failDb(db, 'boom');
      try {
        const r = settle();
        await waitFor(() => expect(frame(r)).toContain('Could not load data'));
      } finally {
        restore();
      }
    });

    it('Enter opens the month in Transactions, filtered to the joint tag', async () => {
      await configuredMay();
      const onNavigate = vi.fn();
      const r = settle({ onNavigate });
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await press(r, '\r');
      await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('transactions', {
        from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01', drillFrom: 'settle',
      }));
    });

    it('Esc goes back to the Owner view on the selected month', async () => {
      await configuredMay();
      const onNavigate = vi.fn();
      const r = settle({ onNavigate });
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await press(r, ESC);
      await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard', { dashView: 'owner', range: 'month', anchor: '2026-05-01' }));
    });

    it('totals what is left to settle across all months after the ratio', async () => {
      await configuredMay(); // May: Pat pays Alex $72
      await db.execute(`INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
        VALUES ('tx-june', 'test-credit', '2026-06-05', 'Grocer', 50, 'Grocery', 0, 0)`);
      await tagged('joint', ['tx-june']); // June: Alex pays Pat 40% of $50 = $20
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Pat 60% / Alex 40% from 2026-05-01  ·  All months: Pat pays Alex $52.00'));
      await pressKeys(r, ['s', 'y']); // settle May
      await waitFor(() => expect(frame(r)).toContain('All months: Alex pays Pat $20.00'));
      await pressKeys(r, [UP, 's', 'y']); // up to June, settle it
      await waitFor(() => expect(frame(r)).toContain('All months: settled'));
    });

    it('puts the all-months total on its own line when it does not fit after the ratio', async () => {
      await configuredMay();
      vi.mocked(loadProfile).mockResolvedValue({
        ...HOUSEHOLD, self: { name: 'Patricia Anne', birthYear: 1985 }, spouse: { name: 'Alexandra Jane', birthYear: 1986 },
      });
      await db.execute("UPDATE accounts SET owner = 'Patricia Anne' WHERE id = 'test-credit'");
      await db.execute("UPDATE accounts SET owner = 'Alexandra Jane' WHERE id = 'test-checking'");
      const r = settle();
      await waitFor(() => expect(frame(r)).toMatch(/from 2026-05-01\s*\n\s*All months: Patricia Anne pays Alexandra Jane \$72\.00/));
    });

    it('shows a window of 12 months that follows the cursor when the split goes back years', async () => {
      await configuredMay();
      await db.execute("UPDATE split_ratios SET start_date = '2024-01-01'"); // Jan 2024 – Jun 2026: 30 months
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('1–12 of 30 months'));
      expect(frame(r)).not.toContain('Jan 2024');
      await pressKeys(r, Array(29).fill(DOWN));
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('19–30 of 30 months');
        expect(f).toContain('JAN 2024');
      });
    });

    describe('ratios', () => {
      const BACKSPACE = '\x7f';

      it('[r] lists the ratios and [a] adds one starting next month', async () => {
        await configuredMay();
        const r = settle();
        await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
        await press(r, 'r');
        await waitFor(() => expect(frame(r)).toContain('Split ratios'));
        expect(frame(r)).toMatch(/2026-05-01\s+60%\s+40%/);
        await press(r, 'a');
        await waitFor(() => expect(frame(r)).toContain('New ratio'));
        expect(frame(r)).toContain('2026-07-01');
        await pressKeys(r, [DOWN, BACKSPACE, BACKSPACE, '5', '7', '.', '5']);
        await press(r, '\r');
        await waitFor(() => expect(frame(r)).toContain('Added the ratio starting 2026-07-01'));
        expect(frame(r)).toMatch(/2026-07-01\s+57\.5%\s+42\.5%/);
        expect(await splitApi.getRatios()).toEqual([
          { startDate: '2026-05-01', selfPct: 60 },
          { startDate: '2026-07-01', selfPct: 57.5 },
        ]);
      });

      it('refuses, inline, to change a ratio over a settled transaction', async () => {
        await configuredMay();
        await tagged('settled', ['tx-groc-1', 'tx-alex-rent']); // latest settled: May 20
        const r = settle();
        await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
        await press(r, 'r');
        await waitFor(() => expect(frame(r)).toContain('Split ratios'));
        await press(r, '\r');
        await waitFor(() => expect(frame(r)).toContain('Edit the ratio starting 2026-05-01'));
        await pressKeys(r, [DOWN, BACKSPACE, BACKSPACE, '5', '0']);
        await press(r, '\r');
        await waitFor(() => expect(frame(r)).toContain("Ratios can't change on or before 2026-05-20"));
        expect(await splitApi.getRatios()).toEqual([{ startDate: '2026-05-01', selfPct: 60 }]);
      });

      it('[x] deletes a ratio, but not the only one', async () => {
        await configuredMay();
        await splitApi.addRatio('2026-07-01', 55);
        const r = settle();
        await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
        await press(r, 'r');
        await waitFor(() => expect(frame(r)).toContain('2026-07-01'));
        await press(r, 'x'); // newest first, so this is July
        await waitFor(() => expect(frame(r)).toContain('Deleted the ratio starting 2026-07-01'));
        await press(r, 'x');
        await waitFor(() => expect(frame(r)).toContain("Can't delete the only ratio"));
        expect(await splitApi.getRatios()).toEqual([{ startDate: '2026-05-01', selfPct: 60 }]);
      });

      it('Esc steps back from the editor to the list, then to the months', async () => {
        await configuredMay();
        const r = settle();
        await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
        await press(r, 'r');
        await press(r, 'a');
        await waitFor(() => expect(frame(r)).toContain('New ratio'));
        await press(r, ESC);
        await waitFor(() => expect(frame(r)).not.toContain('New ratio'));
        expect(frame(r)).toContain('Split ratios');
        await press(r, ESC);
        await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      });
    });

    it('number keys still navigate away', async () => {
      await configuredMay();
      const onNavigate = vi.fn();
      const r = settle({ onNavigate });
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await press(r, '2');
      await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('transactions'));
    });
  });

  // configuredMay leaves 5 May transactions untagged, oldest first: Direct Deposit (May 1,
  // Alex's income), Con Edison (May 3), Sweetgreen (May 9), Amazon (May 11), Trader Joes (May 14).
  describe('review', () => {
    it('shows how many transactions each month still needs reviewed', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('5 transactions not reviewed as joint or personal yet'));
      expect(frame(r)).toMatch(/May 2026.*open\s+5/);
    });

    it('[v] walks the month oldest first, showing each transaction, and j / p / k answer and move on', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await press(r, 'v');
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Review May 2026  ·  1 of 5');
        expect(f).toContain('Test Checking (Alex)');
        expect(f).toContain('May 1, 2026');
        expect(f).toContain('Direct Deposit');
        expect(f).toContain('$3,500.00 in (income or refund)');
        expect(f).toContain('← Income  →');
      });
      await press(r, 'p');
      await waitFor(() => expect(frame(r)).toContain('2 of 5'));
      expect(frame(r)).toContain('Con Edison');
      await press(r, 'j');
      await waitFor(() => expect(frame(r)).toContain('3 of 5'));
      await press(r, 'k');
      await waitFor(() => expect(frame(r)).toContain('4 of 5'));
      expect(await tagsOn('tx-income')).toEqual(['personal']);
      expect(await tagsOn('tx-bills-1')).toEqual(['joint']);
      expect(await tagsOn('tx-dining-1')).toEqual([]); // skipped
    });

    it('← → changes the category, saved with the answer; z undoes both and goes back', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await press(r, 'v');
      await waitFor(() => expect(frame(r)).toContain('← Income  →'));
      await press(r, '\u001b[C'); // → Shopping (categories go alphabetically)
      await waitFor(() => expect(frame(r)).toContain('← Shopping  →'));
      await press(r, 'p');
      await waitFor(() => expect(frame(r)).toContain('2 of 5'));
      const cat = async () => (await db.execute("SELECT category, manual_category FROM transactions WHERE id = 'tx-income'")).rows[0];
      expect(await cat()).toMatchObject({ category: 'Shopping', manual_category: 'Shopping' });
      await press(r, 'z');
      await waitFor(() => expect(frame(r)).toContain('1 of 5'));
      expect(frame(r)).toContain('← Income  →');
      expect(await tagsOn('tx-income')).toEqual([]);
      expect(await cat()).toMatchObject({ category: 'Income', manual_category: null });
    });

    it('asks before marking a transaction joint in a settled month', async () => {
      await configuredMay();
      await tagged('settled', ['tx-groc-1', 'tx-alex-rent']);
      const r = settle();
      await waitFor(() => expect(frame(r)).toMatch(/May 2026.*settled/));
      await press(r, 'v');
      await waitFor(() => expect(frame(r)).toContain('1 of 5'));
      await press(r, 'j');
      await waitFor(() => expect(frame(r)).toContain('marking this joint makes it a top-up'));
      await press(r, 'n');
      await waitFor(() => expect(frame(r)).not.toContain('marking this joint makes it a top-up'));
      expect(await tagsOn('tx-income')).toEqual([]);
      await pressKeys(r, ['j', 'y']);
      await waitFor(() => expect(frame(r)).toContain('2 of 5'));
      expect(await tagsOn('tx-income')).toEqual(['joint']);
    });

    it('settling a month with unreviewed transactions offers review first, then comes back to settle', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('Pat pays Alex $72.00'));
      await press(r, 's');
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('5 transactions in May 2026 not reviewed yet');
        expect(f).toContain('[v] review first  ·  [y] settle anyway');
      });
      await press(r, 'v');
      await waitFor(() => expect(frame(r)).toContain('1 of 5'));
      for (const n of [2, 3, 4, 5]) {
        await press(r, 'p');
        await waitFor(() => expect(frame(r)).toContain(`${n} of 5`));
      }
      await press(r, 'j'); // Trader Joes, Pat's $85: Alex now owes Pat $34 of it
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Settle May 2026');
        expect(f).toContain('Pat pays Alex $38.00');
        expect(f).toContain('[y] settle  ·  [n] cancel');
      });
      expect(frame(r)).not.toContain('not reviewed yet');
      await press(r, 'y');
      await waitFor(() => expect(frame(r)).toContain('Settled May 2026'));
      expect(await tagsOn('tx-groc-2')).toEqual(['joint', 'settled']);
    });

    it('Esc stops reviewing and keeps the answers given so far', async () => {
      await configuredMay();
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await pressKeys(r, ['v']);
      await waitFor(() => expect(frame(r)).toContain('1 of 5'));
      await press(r, 'p');
      await waitFor(() => expect(frame(r)).toContain('2 of 5'));
      await press(r, ESC);
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Stopped reviewing May 2026: 1 marked');
        expect(f).toContain('4 transactions not reviewed as joint or personal yet');
      });
      expect(await tagsOn('tx-income')).toEqual(['personal']);
    });

    it('shows a failed write inline and stays on the same transaction', async () => {
      await configuredMay();
      vi.spyOn(splitApi, 'reviewTransaction').mockRejectedValue(new Error('database is locked'));
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await press(r, 'v');
      await waitFor(() => expect(frame(r)).toContain('1 of 5'));
      await press(r, 'p');
      await waitFor(() => expect(frame(r)).toContain('Could not save: database is locked'));
      expect(frame(r)).toContain('1 of 5');
      expect(await tagsOn('tx-income')).toEqual([]);
    });

    it('answers once even if a key is pressed again while the write is in flight', async () => {
      await configuredMay();
      const real = splitApi.reviewTransaction;
      const spy = vi.spyOn(splitApi, 'reviewTransaction').mockImplementation(
        (...args) => new Promise<void>((res) => setTimeout(res, 60)).then(() => real(...args)),
      );
      const r = settle();
      await waitFor(() => expect(frame(r)).toContain('MAY 2026'));
      await press(r, 'v');
      await waitFor(() => expect(frame(r)).toContain('1 of 5'));
      await pressKeys(r, ['p', 'p']);
      await waitFor(() => expect(frame(r)).toContain('2 of 5'));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await tagsOn('tx-bills-1')).toEqual([]);
    });
  });
});
