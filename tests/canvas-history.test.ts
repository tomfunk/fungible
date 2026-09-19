import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';

// vi.mock is hoisted by Vitest above all imports (and above plain top-level
// statements like `process.env.X = ...`), so this is the only reliable way to
// keep core/canvas-history.ts's module-level CANVAS_HISTORY_PATH/CANVAS_SPEC_PATH
// constants (computed from DATA_DIR at import time) off the real ~/.fungible.
// A prior version of this file set process.env.FUNGIBLE_DATA_DIR as a plain
// statement before the import; that passed locally only because ~/.fungible
// already existed on a dev machine (and got real data clobbered by test runs
// in the process) but failed on CI with ENOENT since the assignment never took
// effect before core/paths.js evaluated. Same pattern as tests/backup.test.ts
// and tests/env-file.test.ts.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(os.tmpdir(), `fungible-canvas-history-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { TEST_DATA_DIR: dir };
});

vi.mock('../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));

// resolveAndWriteCanvasSpec calls resolveCanvasBindings, which orchestrates
// loadHealthData/computeSavingsRate/loadProfile/getSetting — mock those so this
// file tests the history/persistence wiring, not financial calculations (same
// mocking approach as tests/canvas-bindings.test.ts).
const mockHealthData = {
  avgMonthlyExpenses: 4000,
  monthlyIncome: 9000,
  monthlySavings: 5000,
  cash: 30000,
  liquid: 80000,
  retirement: 250000,
  totalDebt: 1500,
  loanDebt: 300000,
  netWorth: 258500,
  basis: 'txn12mo',
  basisLabel: '12-month avg',
};

vi.mock('../core/health.js', () => ({
  loadHealthData: vi.fn(async () => mockHealthData),
  computeSavingsRate: vi.fn(() => 50),
}));

vi.mock('../core/profile.js', () => ({
  loadProfile: vi.fn(async () => ({ self: {}, children: [] })),
}));

vi.mock('../core/settings.js', () => ({
  getSetting: vi.fn(async () => null),
  PRETAX_MONTHLY_KEY: 'pretax_monthly',
}));

import {
  appendHistory,
  getHistoryEntry,
  updateHistoryEntrySpec,
  resolveAndWriteCanvasSpec,
  CANVAS_HISTORY_PATH,
  CANVAS_SPEC_PATH,
} from '../core/canvas-history.js';
import type { CanvasSpec } from '../core/canvas-spec.js';

const SPEC: CanvasSpec = { title: 'T', elements: [{ type: 'text', content: 'original' }] };

beforeEach(() => {
  if (existsSync(CANVAS_HISTORY_PATH)) rmSync(CANVAS_HISTORY_PATH);
  if (existsSync(CANVAS_SPEC_PATH)) rmSync(CANVAS_SPEC_PATH);
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('updateHistoryEntrySpec', () => {
  it('replaces an existing entry\'s spec wholesale, bumps updatedAt, and returns it', () => {
    const entry = appendHistory({ title: 'A', prompt: 'p', spec: SPEC });
    const newSpec: CanvasSpec = { title: 'A', elements: [{ type: 'text', content: 'edited' }] };

    const updated = updateHistoryEntrySpec(entry.id, newSpec);

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(entry.id);
    expect(updated!.spec).toEqual(newSpec);
    expect(updated!.updatedAt).toBeDefined();
    // Persisted to disk, not just returned in memory.
    expect(getHistoryEntry(entry.id)!.spec).toEqual(newSpec);
  });

  it('returns null for a nonexistent id, without throwing', () => {
    appendHistory({ title: 'A', prompt: 'p', spec: SPEC });
    expect(() => updateHistoryEntrySpec('no-such-id', SPEC)).not.toThrow();
    expect(updateHistoryEntrySpec('no-such-id', SPEC)).toBeNull();
  });

  it('does not corrupt other entries in the same history file', () => {
    const a = appendHistory({ title: 'A', prompt: 'p', spec: SPEC });
    const b = appendHistory({ title: 'B', prompt: 'p', spec: SPEC });
    const c = appendHistory({ title: 'C', prompt: 'p', spec: SPEC });
    const newSpec: CanvasSpec = { title: 'B', elements: [{ type: 'text', content: 'only B changes' }] };

    updateHistoryEntrySpec(b.id, newSpec);

    expect(getHistoryEntry(a.id)!.spec).toEqual(SPEC);
    expect(getHistoryEntry(a.id)!.title).toBe('A');
    expect(getHistoryEntry(c.id)!.spec).toEqual(SPEC);
    expect(getHistoryEntry(c.id)!.title).toBe('C');
    expect(getHistoryEntry(b.id)!.spec).toEqual(newSpec);
  });
});

describe('resolveAndWriteCanvasSpec', () => {
  it('resolves live-data bindings and writes CANVAS_SPEC_PATH tagged with the history id', async () => {
    const spec: CanvasSpec = {
      title: 'T',
      elements: [
        { type: 'dial', dial: { key: 'cash', label: 'Cash', default: 1, step: 1, format: 'dollar', hint: 'h', binding: 'cash_balance' } },
      ],
    };
    const entry = appendHistory({ title: 'T', prompt: 'p', spec });

    const resolved = await resolveAndWriteCanvasSpec(spec, entry.id);

    expect((resolved.elements[0] as { dial: { default: number } }).dial.default).toBe(mockHealthData.cash);

    const onDisk = JSON.parse(readFileSync(CANVAS_SPEC_PATH, 'utf-8'));
    expect(onDisk._historyId).toBe(entry.id);
    expect(typeof onDisk._writtenAt).toBe('number');
    expect(onDisk.title).toBe('T');
    expect(onDisk.elements[0].dial.default).toBe(mockHealthData.cash);
  });
});
