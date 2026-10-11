// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Rules } from '../../gui/renderer/src/screens/Rules.js';

const TRAVEL = 1;
const WORK = 2;

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'transactions', 'accounts',
                     'categories', 'tags', 'category_rules', 'name_rules', 'hidden_categories',
                     'balance_history', 'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => cleanup());

async function rows(sql: string) {
  return (await db.execute(sql)).rows.map((r) => ({ ...r }));
}
const tagRules = () => rows('SELECT * FROM tag_rules ORDER BY id');
const tagged = (tagId: number) =>
  rows(`SELECT t.id, t.account_id FROM transaction_tags tt JOIN transactions t ON t.id = tt.transaction_id
        WHERE tt.tag_id = ${tagId} ORDER BY t.id`);

const field = (label: string) =>
  screen.getByText(label, { selector: 'label' }).nextElementSibling as HTMLInputElement & HTMLSelectElement;
const saveBtn = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const modal = () => screen.queryByText(/^(New|Edit) tag rule$/);

async function openTagRules() {
  renderScreen(<Rules />);
  await userEvent.click(await screen.findByRole('button', { name: /Tag rules/ }));
}
async function openNew() {
  await openTagRules();
  await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
  await screen.findByText('New tag rule');
}
async function seedRule(r: { type?: string; pattern?: string; tag?: number; account?: string | null; min?: number | null; max?: number | null }) {
  await db.execute({
    sql: `INSERT INTO tag_rules (priority, match_type, pattern, tag_id, min_amount, max_amount, account_id)
          VALUES (10, ?, ?, ?, ?, ?, ?)`,
    args: [r.type ?? 'all', r.pattern ?? '', r.tag ?? TRAVEL, r.min ?? null, r.max ?? null, r.account ?? null],
  });
}

describe('GUI Rules — tag rules tab', () => {
  it('shows the empty state and opens a new-rule form defaulting to "all" with no Pattern field', async () => {
    await openTagRules();
    expect(screen.getByRole('button', { name: 'Tag rules (0)' })).toBeTruthy();
    expect(screen.getByText(/No tag rules yet\./)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await screen.findByText('New tag rule');
    expect(field('Match type').value).toBe('all');
    expect(screen.queryByText('Pattern', { selector: 'label' })).toBeNull();
  });

  it('an "all" rule scoped to one account: live count, saves, and tags exactly that account', async () => {
    await openNew();
    // No scope yet: every transaction.
    await waitFor(() => expect(screen.getByText('9 transactions match')).toBeTruthy());
    await userEvent.selectOptions(field('Tag'), 'travel');
    await userEvent.selectOptions(field('Account'), 'Test Visa');
    await waitFor(() => expect(screen.getByText('7 transactions match')).toBeTruthy());

    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Tag rule saved · tagged 7 transactions')).toBeTruthy());

    const rules = await tagRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      match_type: 'all', pattern: '', tag_id: TRAVEL, account_id: 'test-credit', priority: 10,
      min_amount: null, max_amount: null,
    });
    const t = await tagged(TRAVEL);
    expect(t).toHaveLength(7);
    expect(t.every((r) => r.account_id === 'test-credit')).toBe(true);
    expect(await tagged(WORK)).toHaveLength(0);
    // The list shows the new rule, scoped by the account's name.
    expect(screen.getByRole('button', { name: 'Tag rules (1)' })).toBeTruthy();
    const row = screen.getByText('— all —').closest('tr')!;
    expect(row.textContent).toContain('travel');
    expect(row.textContent).toContain('Test Visa');
  });

  it('a name rule with a Min $ narrows the live count and the tagged set', async () => {
    await openNew();
    await userEvent.selectOptions(field('Match type'), 'name');
    await userEvent.type(field('Pattern'), 'Whole Foods');
    await waitFor(() => expect(screen.getByText('2 transactions match')).toBeTruthy()); // May + April
    await userEvent.type(field('Min $ (optional)'), '110');
    await waitFor(() => expect(screen.getByText('1 transactions match')).toBeTruthy());

    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Tag rule saved · tagged 1 transaction')).toBeTruthy());
    expect(await tagRules()).toMatchObject([{ match_type: 'name', pattern: 'Whole Foods', min_amount: 110, max_amount: null }]);
    expect((await tagged(TRAVEL)).map((r) => r.id)).toEqual(['tx-groc-1']);
  });

  it('a Max $ bound excludes larger amounts', async () => {
    await openNew();
    await userEvent.selectOptions(field('Match type'), 'name');
    await userEvent.type(field('Pattern'), 'Whole Foods');
    await userEvent.type(field('Max $ (optional)'), '110');
    await waitFor(() => expect(screen.getByText('1 transactions match')).toBeTruthy());
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(/Tag rule saved/)).toBeTruthy());
    expect(await tagRules()).toMatchObject([{ min_amount: null, max_amount: 110 }]);
    expect((await tagged(TRAVEL)).map((r) => r.id)).toEqual(['tx-groc-apr']);
  });

  it('an invalid regex counts 0, shows an inline error, keeps the modal open and saves nothing', async () => {
    await openNew();
    await userEvent.selectOptions(field('Match type'), 'regex');
    await userEvent.type(field('Pattern'), '(');
    await waitFor(() => expect(screen.getByText('0 transactions match')).toBeTruthy());
    await userEvent.click(saveBtn());
    await waitFor(() => expect(document.querySelector('p.neg')).not.toBeNull());
    expect(document.querySelector('p.neg')!.textContent).toBeTruthy();
    expect(modal()).not.toBeNull();
    expect(await tagRules()).toEqual([]);
    expect(await tagged(TRAVEL)).toEqual([]);

    // Fixing the pattern saves.
    const pattern = field('Pattern');
    await userEvent.clear(pattern);
    await userEvent.type(pattern, '^Whole');
    await waitFor(() => expect(screen.getByText('2 transactions match')).toBeTruthy());
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Tag rule saved · tagged 2 transactions')).toBeTruthy());
    expect(await tagRules()).toMatchObject([{ match_type: 'regex', pattern: '^Whole' }]);
  });

  it('a name rule needs a pattern before Save is enabled', async () => {
    await openNew();
    await userEvent.selectOptions(field('Match type'), 'name');
    expect(saveBtn().disabled).toBe(true);
    await userEvent.type(field('Pattern'), '   ');
    expect(saveBtn().disabled).toBe(true);
    await userEvent.type(field('Pattern'), 'Amazon');
    expect(saveBtn().disabled).toBe(false);
  });

  it('with no tags defined, says so and disables Save', async () => {
    await db.execute('DELETE FROM tags');
    await openNew();
    expect(screen.getByRole('option', { name: 'No tags yet — create one first' })).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
  });

  it('editing a rule prefills it; changing the tag updates the same row', async () => {
    await seedRule({ type: 'name', pattern: 'Whole Foods', tag: TRAVEL, min: 50, account: 'test-credit' });
    await openTagRules();
    await userEvent.click(await screen.findByText('Whole Foods'));
    await screen.findByText('Edit tag rule');
    expect(field('Match type').value).toBe('name');
    expect(field('Pattern').value).toBe('Whole Foods');
    expect(field('Min $ (optional)').value).toBe('50');
    expect(field('Max $ (optional)').value).toBe('');
    expect(field('Account').value).toBe('test-credit');
    expect(field('Tag').value).toBe(String(TRAVEL));

    await userEvent.selectOptions(field('Tag'), 'work');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(/Tag rule saved/)).toBeTruthy());
    const rules = await tagRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tag_id: WORK, pattern: 'Whole Foods', min_amount: 50, account_id: 'test-credit' });
    expect((await tagged(WORK)).map((r) => r.id)).toEqual(['tx-groc-1', 'tx-groc-apr']);
  });

  it('creating the same rule twice leaves one row with the updated amounts', async () => {
    await openNew();
    await userEvent.selectOptions(field('Match type'), 'name');
    await userEvent.type(field('Pattern'), 'Whole Foods');
    await userEvent.type(field('Min $ (optional)'), '10');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText(/Tag rule saved/)).toBeTruthy());
    await waitFor(() => expect(modal()).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await screen.findByText('New tag rule');
    await userEvent.selectOptions(field('Match type'), 'name');
    await userEvent.type(field('Pattern'), 'Whole Foods');
    await userEvent.type(field('Min $ (optional)'), '110');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tag rules (1)' })).toBeTruthy());
    await waitFor(async () => expect(await tagRules()).toMatchObject([{ min_amount: 110 }]));
    expect(await tagRules()).toHaveLength(1);
  });

  it('deleting a rule keeps the tags it already applied', async () => {
    await openNew();
    await userEvent.selectOptions(field('Account'), 'Test Visa');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Tag rule saved · tagged 7 transactions')).toBeTruthy());
    await waitFor(() => expect(modal()).toBeNull());

    const row = screen.getByText('— all —').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'delete' }));
    await waitFor(() => expect(screen.getByText('Tag rule deleted · existing tags left in place')).toBeTruthy());
    expect(await tagRules()).toEqual([]);
    expect(await tagged(TRAVEL)).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Tag rules (0)' })).toBeTruthy();
  });

  it('a tag the user removed (suppression) is excluded from the apply count and not re-added', async () => {
    await db.execute({ sql: 'INSERT INTO tag_rule_suppressions (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-groc-1', TRAVEL] });
    await openNew();
    await userEvent.selectOptions(field('Account'), 'Test Visa');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Tag rule saved · tagged 6 transactions')).toBeTruthy());
    const ids = (await tagged(TRAVEL)).map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain('tx-groc-1');
  });

  // Min/Max accept a lone '-' or '.', which parseFloat turns into NaN. Verified: the
  // save is refused (nothing is written, so the rule is not silently widened) but the
  // inline error is the raw driver message ("Only finite numbers ... can be passed as
  // arguments"), not something a user can act on. Pinned here: refusal, not the wording.
  it.each([
    ['Min $ (optional)', '-'],
    ['Max $ (optional)', '.'],
  ])('a lone %s "%s" does not save a widened rule', async (label, junk) => {
    await openNew();
    await userEvent.selectOptions(field('Match type'), 'name');
    await userEvent.type(field('Pattern'), 'Whole Foods');
    await userEvent.type(field(label), junk);
    await userEvent.click(saveBtn());
    await waitFor(() => expect(document.querySelector('p.neg')).not.toBeNull());
    expect(modal()).not.toBeNull();
    expect(await tagRules()).toEqual([]);
    expect(await tagged(TRAVEL)).toEqual([]);
  });
});
