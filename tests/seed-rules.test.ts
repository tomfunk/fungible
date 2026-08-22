import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { seedRules } from '../core/seed-rules.js';
import { getAllCategories } from '../core/queries.js';

beforeEach(async () => {
  await db.execute('DELETE FROM category_rules');
  await db.execute('DELETE FROM categories');
  await db.execute('DELETE FROM transactions');
});

describe('seedRules', () => {
  it('registers every category its rules assign, so the pickers offer them', async () => {
    await seedRules();

    const ruleCats = (await db.execute('SELECT DISTINCT category FROM category_rules'))
      .rows as unknown as { category: string }[];
    const categories = await getAllCategories();

    expect(ruleCats.length).toBeGreaterThan(0);
    for (const { category } of ruleCats) expect(categories).toContain(category);
  });

  it('offers Subscriptions, the category its streaming rules assign', async () => {
    await seedRules();
    expect(await getAllCategories()).toContain('Subscriptions');
  });

  it('leaves an existing category row untouched', async () => {
    await db.execute("INSERT INTO categories (name, flexibility) VALUES ('Subscriptions', 'fixed')");
    await seedRules();
    const row = (await db.execute("SELECT flexibility FROM categories WHERE name = 'Subscriptions'"))
      .rows[0] as unknown as { flexibility: string };
    expect(row.flexibility).toBe('fixed');
  });
});
