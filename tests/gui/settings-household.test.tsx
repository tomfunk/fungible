// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Settings } from '../../gui/renderer/src/screens/Settings.js';

type Bridge = { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> };
const bridge = () => (window as unknown as { __bridge: Bridge }).__bridge;

const HINT = 'Every member needs a name and a valid birth year.';
const thisYear = new Date().getFullYear();

const names = () => screen.getAllByPlaceholderText('Name') as HTMLInputElement[];
const years = () => screen.getAllByPlaceholderText('Birth year') as HTMLInputElement[];
const saveBtn = () => screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement;

async function members() {
  const res = await db.execute('SELECT id, name, birth_year, sort_order FROM household_members ORDER BY sort_order');
  return res.rows.map((r) => ({ id: r.id, name: r.name, birth_year: r.birth_year, sort_order: r.sort_order }));
}

async function seedFamily() {
  await db.batch(
    [
      "INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('self', 'Alex', 1985, 0)",
      "INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('spouse', 'Sam', 1987, 1)",
      "INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('child-0', 'Kid One', 2019, 2)",
      "INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('child-1', 'Kid Two', 2021, 3)",
    ],
    'write',
  );
}

async function renderLoaded() {
  renderScreen(<Settings />);
  await waitFor(() => expect(screen.getByText('Household')).toBeTruthy());
}

beforeEach(async () => {
  for (const tbl of ['settings', 'household_members']) await db.execute(`DELETE FROM ${tbl}`);
  installBridge();
});

afterEach(() => cleanup());

describe('GUI Settings — household profile', () => {
  it('with no profile: empty form, Save disabled with a hint; filling in self enables Save and persists it', async () => {
    await renderLoaded();
    expect(names()).toHaveLength(1);
    expect(names()[0].value).toBe('');
    expect(years()[0].value).toBe('');
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByText(HINT)).toBeTruthy();

    await userEvent.type(names()[0], 'Alex');
    await userEvent.type(years()[0], '1985');
    expect(saveBtn().disabled).toBe(false);
    expect(screen.queryByText(HINT)).toBeNull();

    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Profile saved')).toBeTruthy());
    expect(await members()).toEqual([{ id: 'self', name: 'Alex', birth_year: 1985, sort_order: 0 }]);
  });

  it('loads an existing profile into labelled rows', async () => {
    await seedFamily();
    await renderLoaded();
    await waitFor(() => expect(names()).toHaveLength(4));
    expect(names().map((i) => i.value)).toEqual(['Alex', 'Sam', 'Kid One', 'Kid Two']);
    expect(years().map((i) => i.value)).toEqual(['1985', '1987', '2019', '2021']);
    for (const label of ['You', 'Spouse', 'Child 1', 'Child 2']) expect(screen.getByText(label)).toBeTruthy();
    // Spouse already present: the add-spouse button is gone.
    expect(screen.queryByRole('button', { name: '+ Add spouse / partner' })).toBeNull();
    expect(saveBtn().disabled).toBe(false);
  });

  describe('birth year validation', () => {
    it.each([
      { label: 'the current year', year: String(thisYear), ok: true },
      { label: 'next year', year: String(thisYear + 1), ok: false },
      { label: '1899', year: '1899', ok: false },
      { label: '1900', year: '1900', ok: true },
    ])('$label -> Save enabled: $ok', async ({ year, ok }) => {
      await renderLoaded();
      await userEvent.type(names()[0], 'Alex');
      await userEvent.type(years()[0], year);
      expect(saveBtn().disabled).toBe(!ok);
    });

    it('a blank year keeps Save disabled', async () => {
      await renderLoaded();
      await userEvent.type(names()[0], 'Alex');
      expect(saveBtn().disabled).toBe(true);
    });

    it('a year that was valid and is cleared disables Save again', async () => {
      await seedFamily();
      await renderLoaded();
      await waitFor(() => expect(years()).toHaveLength(4));
      expect(saveBtn().disabled).toBe(false);
      await userEvent.clear(years()[0]);
      expect(saveBtn().disabled).toBe(true);
    });

    it('strips non-digits while typing', async () => {
      await renderLoaded();
      await userEvent.type(years()[0], '19ab85');
      expect(years()[0].value).toBe('1985');
    });

    it('caps the year at four digits', async () => {
      await renderLoaded();
      await userEvent.type(years()[0], '198567');
      expect(years()[0].value).toBe('1985');
    });
  });

  it('adds a spouse, requires it be filled in, and saves it as sort_order 1', async () => {
    await db.execute("INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('self', 'Alex', 1985, 0)");
    await renderLoaded();
    await waitFor(() => expect(names()[0].value).toBe('Alex'));
    expect(saveBtn().disabled).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: '+ Add spouse / partner' }));
    expect(screen.queryByRole('button', { name: '+ Add spouse / partner' })).toBeNull();
    expect(screen.getByText('Spouse')).toBeTruthy();
    expect(saveBtn().disabled).toBe(true); // blank spouse

    await userEvent.type(names()[1], 'Sam');
    expect(saveBtn().disabled).toBe(true); // name but no year
    await userEvent.type(years()[1], '1987');
    expect(saveBtn().disabled).toBe(false);
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Profile saved')).toBeTruthy());
    expect(await members()).toEqual([
      { id: 'self', name: 'Alex', birth_year: 1985, sort_order: 0 },
      { id: 'spouse', name: 'Sam', birth_year: 1987, sort_order: 1 },
    ]);
  });

  it('removing the spouse and saving deletes the spouse row', async () => {
    await seedFamily();
    await renderLoaded();
    await waitFor(() => expect(names()).toHaveLength(4));
    const spouseRow = screen.getByText('Spouse').closest('div')!;
    await userEvent.click(spouseRow.querySelector('button')!);
    expect(screen.queryByText('Spouse')).toBeNull();
    expect(screen.getByRole('button', { name: '+ Add spouse / partner' })).toBeTruthy();
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Profile saved')).toBeTruthy());
    expect((await members()).map((m) => m.id)).toEqual(['self', 'child-0', 'child-1']);
  });

  it('removing the first of two children keeps the second child, renumbered, and no stale child row', async () => {
    await db.execute("INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('self', 'Alex', 1985, 0)");
    await renderLoaded();
    await waitFor(() => expect(names()[0].value).toBe('Alex'));
    await userEvent.click(screen.getByRole('button', { name: '+ Add child' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add child' }));
    expect(names()).toHaveLength(3);
    await userEvent.type(names()[1], 'First');
    await userEvent.type(years()[1], '2018');
    await userEvent.type(names()[2], 'Second');
    await userEvent.type(years()[2], '2020');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Profile saved')).toBeTruthy());
    expect((await members()).map((m) => m.id)).toEqual(['self', 'child-0', 'child-1']);

    // Remove the first child and save again.
    await userEvent.click(screen.getByText('Child 1').closest('div')!.querySelector('button')!);
    expect(screen.queryByText('Child 2')).toBeNull();
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getAllByText('Profile saved').length).toBeGreaterThan(0));
    await waitFor(async () => expect((await members()).map((m) => m.id)).toEqual(['self', 'child-0']));
    // Canary: the stale 'child-1' must be deleted, and child-0 carries the SECOND child's data.
    expect(await members()).toEqual([
      { id: 'self', name: 'Alex', birth_year: 1985, sort_order: 0 },
      { id: 'child-0', name: 'Second', birth_year: 2020, sort_order: 2 },
    ]);

    // A fresh mount shows exactly one child.
    cleanup();
    await renderLoaded();
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(screen.getByText('Child 1')).toBeTruthy();
    expect(screen.queryByText('Child 2')).toBeNull();
    expect(names()[1].value).toBe('Second');
  });

  it('trims names on save', async () => {
    await renderLoaded();
    await userEvent.type(names()[0], '  Alex  ');
    await userEvent.type(years()[0], '1985');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Profile saved')).toBeTruthy());
    expect((await members())[0].name).toBe('Alex');
  });

  it('trims spouse and child names on save', async () => {
    await seedFamily();
    await renderLoaded();
    await waitFor(() => expect(names()).toHaveLength(4));
    await userEvent.type(names()[1], '  '); // 'Sam  '
    await userEvent.type(names()[2], '  '); // 'Kid One  '
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Profile saved')).toBeTruthy());
    expect((await members()).map((m) => m.name)).toEqual(['Alex', 'Sam', 'Kid One', 'Kid Two']);
  });

  it('a whitespace-only child name keeps Save disabled', async () => {
    await db.execute("INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('self', 'Alex', 1985, 0)");
    await renderLoaded();
    await waitFor(() => expect(names()[0].value).toBe('Alex'));
    await userEvent.click(screen.getByRole('button', { name: '+ Add child' }));
    await userEvent.type(names()[1], '   ');
    await userEvent.type(years()[1], '2019');
    expect(saveBtn().disabled).toBe(true);
    await userEvent.type(names()[1], 'Kid');
    expect(saveBtn().disabled).toBe(false);
  });

  // ── Failure probes ────────────────────────────────────────────────────────
  // Settings calls `void save()` / `void api.profile.loadProfile().then(...)` with
  // no catch, so a rejected bridge call is an unhandled rejection and the user
  // sees nothing. Expected behaviour (an error toast / not stuck on "Loading…")
  // is pinned as it.fails so it flips to a failure the day the screen handles it.
  // The rejection is swallowed locally so it does not fail the whole run.
  async function swallowingUnhandled<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', () => {});
    try {
      return await fn();
    } finally {
      process.removeAllListeners('unhandledRejection');
      for (const l of saved) process.on('unhandledRejection', l);
    }
  }

  it.fails('PRODUCT BUG: a rejected saveProfile shows an error toast instead of failing silently', async () => {
    await swallowingUnhandled(async () => {
      await renderLoaded();
      const prev = bridge().call;
      bridge().call = async (ns, fn, args) => {
        if (ns === 'profile' && fn === 'saveProfile') throw new Error('disk full');
        return prev(ns, fn, args);
      };
      await userEvent.type(names()[0], 'Alex');
      await userEvent.type(years()[0], '1985');
      await userEvent.click(saveBtn());
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText('Profile saved')).toBeNull(); // (true today)
      expect(document.querySelector('[class*="toast"]')).not.toBeNull(); // (fails today: no toast)
    });
  });

  it.fails('PRODUCT BUG: a rejected loadProfile does not leave the screen on "Loading…" forever', async () => {
    await swallowingUnhandled(async () => {
      const prev = bridge().call;
      bridge().call = async (ns, fn, args) => {
        if (ns === 'profile' && fn === 'loadProfile') throw new Error('db locked');
        return prev(ns, fn, args);
      };
      renderScreen(<Settings />);
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText('Loading…')).toBeNull();
    });
  });
});
