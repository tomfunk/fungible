import { describe, it, expect, vi } from 'vitest';

describe('balance-import-copy', () => {
  it('loads with db and refresh mocked to throw (no imports/side effects)', async () => {
    vi.resetModules();
    vi.doMock('../core/db.js', () => { throw new Error('db must not load'); });
    vi.doMock('../core/refresh.js', () => { throw new Error('refresh must not load'); });
    const copy = await import('../core/balance-import-copy.js');
    expect(copy.summarizeSkips([{ reason: 'invalid_date' }, { reason: 'invalid_amount' }])).toBe('2 invalid date or amount');
    expect(copy.BALANCE_IMPORT_SKIP_REASONS.length).toBe(8);
    vi.doUnmock('../core/db.js');
    vi.doUnmock('../core/refresh.js');
  });

  it('balance-import re-exports identical values', async () => {
    vi.resetModules();
    const copy = await import('../core/balance-import-copy.js');
    const main = await import('../core/balance-import.js');
    expect(main.BALANCE_IMPORT_SKIP_REASONS).toBe(copy.BALANCE_IMPORT_SKIP_REASONS);
    expect(main.BALANCE_IMPORT_SKIP_COPY).toBe(copy.BALANCE_IMPORT_SKIP_COPY);
    expect(main.summarizeSkips).toBe(copy.summarizeSkips);
  });
});
