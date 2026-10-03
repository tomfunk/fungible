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
import { Rules } from '../../tui/Rules.js';
import { waitFor, frame } from '../helpers/waitFor.js';
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

describe('Rules', () => {
  function rules(overrides?: Partial<Parameters<typeof Rules>[0]>) {
    return render(
      <W>
        <Rules onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders the Rules / Tag Rules / Categories section tabs', () => {
    const f = frame(rules());
    expect(f).toContain('Tag Rules');
    expect(f).toContain('Categories');
  });

  it('shows seeded category rule after load', async () => {
    const r = rules();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Whole Foods');
    });
  });

  it('Tab cycles to Categories section showing seeded categories', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\t');
    r.stdin.write('\t'); // rules → tags → categories
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Grocery');
      expect(f).toContain('Dining');
    });
  });

  it('Tab cycles to Tag Rules section', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\t'); // rules → tags
    await waitFor(() => expect(frame(r)).toContain('No tag rules yet'));
    r.stdin.write('a');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('New Tag Rule');
      expect(f).toContain('Match type');
      expect(f).toContain('transactions match');
    });
  });

  it('[a] opens the new rule form with both a category and a display name field', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods')); // rules loaded
    r.stdin.write('a');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('New Rule');
      expect(f).toContain('Pattern');
      expect(f).toContain('Category');
      expect(f).toContain('Display name');
    });
  });

  it('typing a pattern, Enter to Category, picking one, then Enter saves the rule', async () => {
    // A new rule starts on "— none —", so the first Enter moves the cursor to
    // Category instead of saving; the second one (with a category picked) saves.
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Rule'));
    for (const ch of 'Starbucks') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('Starbucks'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('New Rule')); // still open, nothing saved
    await new Promise((res) => setTimeout(res, 10));
    r.stdin.write('\x1b[C'); // → only moves the picker if the cursor landed on Category
    await waitFor(() => expect(frame(r)).toContain('Bills & Utilities'));
    await new Promise((res) => setTimeout(res, 10));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('New Rule');
      expect(f).toContain('Starbucks');
    });
    const cats = await db.execute("SELECT category FROM category_rules WHERE pattern = 'Starbucks'");
    expect(cats.rows).toHaveLength(1);
    expect((cats.rows[0] as unknown as { category: string }).category).toBe('Bills & Utilities');
  });

  it('a new rule defaults to no category and Enter on it writes nothing', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('a');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('New Rule');
      expect(f).toContain('— none —');            // no category pre-selected
      expect(f).not.toContain('Bills & Utilities'); // ...not the first-sorting one
    });
    for (const ch of 'Starbucks') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('Starbucks'));
    r.stdin.write('\r');
    // Enter guided instead of saving: the form is still open and nothing was written.
    await waitFor(() => expect(frame(r)).toContain('New Rule'));
    const cats = await db.execute("SELECT id FROM category_rules WHERE pattern = 'Starbucks'");
    const names = await db.execute("SELECT id FROM name_rules WHERE pattern = 'Starbucks'");
    expect(cats.rows).toHaveLength(0);
    expect(names.rows).toHaveLength(0);
  });

  it('Enter with an empty pattern leaves the cursor where it is', async () => {
    // Nothing to guide toward, so Enter stays a no-op: ← must still do nothing,
    // which it only does while the cursor sits on the Pattern field.
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Rule'));
    r.stdin.write('\r');
    await new Promise((res) => setTimeout(res, 10));
    r.stdin.write('\x1b[C'); // would advance the picker if Enter had jumped to Category
    await new Promise((res) => setTimeout(res, 50));
    const f = frame(r);
    expect(f).toContain('New Rule');
    expect(f).toContain('— none —');
    expect(f).not.toContain('Bills & Utilities');
  });

  it('"— none —" says it removes the rule only when editing one that has a category', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    // New rule: nothing to remove, so the plain label.
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Rule'));
    expect(frame(r)).not.toContain('removes rule');
    r.stdin.write('\x1b'); // Esc back to the list
    await waitFor(() => expect(frame(r)).not.toContain('New Rule'));

    // Editing the seeded category rule: cursoring to "none" means deleting it.
    await new Promise((res) => setTimeout(res, 10));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Edit Rule'));
    expect(frame(r)).toContain('Grocery');
    expect(frame(r)).not.toContain('removes rule'); // a category is still selected
    for (let i = 0; i < 4; i++) r.stdin.write('\x1b[B'); // → Category
    await new Promise((res) => setTimeout(res, 10));
    for (let i = 0; i < 3; i++) r.stdin.write('\x1b[D'); // ← past Dining, Bills & Utilities, to none
    await waitFor(() => expect(frame(r)).toContain('— none (removes rule) —'));
  });

  it('a name-only rule shows the plain "— none —" label, with no removal warning', async () => {
    await db.execute('DELETE FROM category_rules');
    await db.execute(
      "INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'sq *', 'Square')",
    );
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Square'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Edit Rule'));
    const f = frame(r);
    expect(f).toContain('— none —');
    expect(f).not.toContain('removes rule');
  });

  it('Enter on existing rule opens edit form pre-filled with its pattern', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Edit Rule');
      expect(f).toContain('Whole Foods');
    });
  });

  it('Esc from search preserves cursor on the highlighted rule (not the unfiltered top)', async () => {
    // Regression: pressing Esc in search used to reset cursor to its pre-search
    // numeric index, so the highlighted (filtered) rule could differ from what
    // 'x' then deleted. Now the cursor re-anchors to that rule by id.
    await db.execute('DELETE FROM category_rules');
    await db.batch([
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Aaa Coffee', 'Dining')",
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Bbb Diner',  'Dining')",
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Zzz Lounge', 'Dining')",
    ], 'write');

    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Aaa Coffee'));
    r.stdin.write('/');
    await waitFor(() => expect(frame(r)).toContain('Esc clear')); // search bar visible
    for (const ch of 'Zzz') r.stdin.write(ch);
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Zzz Lounge');
      expect(f).not.toContain('Aaa Coffee'); // filter is active
    });
    r.stdin.write('\x1b');         // Esc clears search
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Aaa Coffee'); // full list back
      // ▶ cursor marker should sit on the Zzz row, not the top.
      const zzzLine = f.split('\n').find((l) => l.includes('Zzz Lounge'))!;
      expect(zzzLine.includes('▶')).toBe(true);
    });
  });

  it('[x] deletes the rule and surfaces the recategorized count in the status', async () => {
    // Self-contained: clear seeded transactions/rules so the count pins to exactly 1.
    // Mirrors the GUI delete test (tests/gui/rules.test.tsx) and locks the singular
    // pluralization of the status message ("1 transaction", not "1 transactions").
    await db.execute('DELETE FROM category_rules');
    await db.execute('DELETE FROM transactions');
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-tj', 'test-credit', '2026-05-15', 'Trader Joes', 50.00, 'Grocery', 0, 0)`,
    );
    await db.execute(
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Trader Joes', 'Grocery')",
    );

    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('x');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toMatch(/Rule deleted · recategorized 1 transaction\b/); // \b rejects trailing 's'
      expect(f).not.toContain('Trader Joes'); // rule gone from the list
    });
  });

  it('a category rule and a name rule with the same conditions render as one row', async () => {
    // Seeded category rule: name/'Whole Foods' → Grocery. Same conditions, so
    // the two collapse into a single row carrying both.
    await db.execute(
      "INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'Whole Foods', 'WF Market')",
    );
    const r = rules();
    await waitFor(() => {
      const line = frame(r).split('\n').find((l) => l.includes('Whole Foods'));
      expect(line).toBeDefined();
      expect(line).toContain('Grocery');   // category cell
      expect(line).toContain('WF Market'); // display-name cell
    });
    // One row, not two.
    await waitFor(() => expect(frame(r)).toContain('1 rules'));
  });

  it('a name rule with no category rule shows as a row with an empty category', async () => {
    await db.execute('DELETE FROM category_rules');
    await db.execute(
      "INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'sq *', 'Square')",
    );
    const r = rules();
    await waitFor(() => {
      const line = frame(r).split('\n').find((l) => l.includes('sq *'));
      expect(line).toBeDefined();
      expect(line).toContain('Square');
    });
  });

  it('one save writes both a category rule and a name rule', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Rule'));
    for (const ch of 'amazon') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('amazon'));
    for (let i = 0; i < 4; i++) r.stdin.write('\x1b[B'); // pattern → category
    // Consecutive writes coalesce into one chunk, and a chunk mixing two
    // different sequences is read as a single key — so the → gets its own.
    await new Promise((res) => setTimeout(res, 10));
    r.stdin.write('\x1b[C'); // → off "— none —" onto the first category
    await waitFor(() => expect(frame(r)).toContain('Bills & Utilities'));
    await new Promise((res) => setTimeout(res, 10));
    r.stdin.write('\x1b[B'); // → display name
    // Wait for React to commit the field navigation before typing (avoids stale closure)
    await waitFor(() => expect(frame(r)).toContain('display name'));
    for (const ch of 'Amazon') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('Amazon'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('New Rule');
      expect(f).toContain('amazon');
      expect(f).toContain('Amazon');
    });
    const cats = await db.execute("SELECT category FROM category_rules WHERE pattern = 'amazon'");
    const names = await db.execute("SELECT replacement FROM name_rules WHERE pattern = 'amazon'");
    expect(cats.rows).toHaveLength(1);
    expect(names.rows).toHaveLength(1);
    expect((names.rows[0] as unknown as { replacement: string }).replacement).toBe('Amazon');
  });

  it('leaving the category on "— none —" saves a name rule only', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Rule'));
    for (const ch of 'amazon') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('amazon'));
    // The category is already on "— none —" (a new rule's default), so this
    // walks straight past it to the display name.
    await waitFor(() => expect(frame(r)).toContain('— none —'));
    for (let i = 0; i < 5; i++) r.stdin.write('\x1b[B'); // pattern → display name
    await waitFor(() => expect(frame(r)).toContain('display name'));
    for (const ch of 'Amazon') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('Amazon'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).not.toContain('New Rule'));
    const cats = await db.execute("SELECT category FROM category_rules WHERE pattern = 'amazon'");
    const names = await db.execute("SELECT replacement FROM name_rules WHERE pattern = 'amazon'");
    expect(cats.rows).toHaveLength(0);
    expect(names.rows).toHaveLength(1);
  });

  it('[x] on a combined row deletes both underlying rules', async () => {
    await db.execute(
      "INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'Whole Foods', 'WF Market')",
    );
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('WF Market'));
    r.stdin.write('x');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Rule deleted');
      expect(f).toContain('No rules yet');
    });
    const cats = await db.execute("SELECT id FROM category_rules WHERE pattern = 'Whole Foods'");
    const names = await db.execute("SELECT id FROM name_rules WHERE pattern = 'Whole Foods'");
    expect(cats.rows).toHaveLength(0);
    expect(names.rows).toHaveLength(0);
  });

  it('Enter in categories section opens the edit panel', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\t');
    r.stdin.write('\t'); // categories section
    await waitFor(() => expect(frame(r)).toContain('Bills & Utilities'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Edit: Bills & Utilities');
      expect(f).toContain('Name');
      expect(f).toContain('Flexibility');
    });
  });

  it('Esc in categories edit panel closes without navigating away', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\t');
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('Bills & Utilities'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Edit: Bills & Utilities'));
    r.stdin.write('\x1b');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Edit: Bills & Utilities');
      expect(f).toContain('Bills & Utilities');
    });
  });

});
