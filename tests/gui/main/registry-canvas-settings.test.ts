import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

// DATA SAFETY: core/paths reads FUNGIBLE_DATA_DIR at import, so set a temp dir
// before the registry (and core/canvas-history, core/env-file) load. core/db is replaced.
const h = vi.hoisted(() => {
  const dir = (process.env.FUNGIBLE_DATA_DIR = `${(process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/fungible-registry-canvas-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { dir };
});
vi.mock('../../../core/db.js', async () => ({
  db: await (await import('../../helpers/makeTestDb.js')).makeTestDb(),
}));

import { db } from '../../../core/db.js';
import { registry } from '../../../gui/main/registry.js';
import { CANVAS_SPEC_PATH, CANVAS_HISTORY_PATH, loadHistory } from '../../../core/canvas-history.js';
import { saveProfile } from '../../../core/profile.js';
import type { CanvasSpec } from '../../../core/canvas-spec.js';

const spec = (title: string): CanvasSpec => ({ title, elements: [] });
const entry = (id: string, title: string) => ({ id, title, prompt: 'p', spec: spec(title), createdAt: '2026-01-01T00:00:00.000Z' });

beforeEach(async () => {
  rmSync(h.dir, { recursive: true, force: true });
  mkdirSync(h.dir, { recursive: true });
  await db.execute('DELETE FROM settings');
  await db.execute('DELETE FROM household_members');
});
afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

describe('canvas paths are inside the temp data dir (safety net)', () => {
  it('never resolves into the real data dir', () => {
    expect(CANVAS_SPEC_PATH.startsWith(h.dir)).toBe(true);
    expect(CANVAS_HISTORY_PATH.startsWith(h.dir)).toBe(true);
  });
});

describe('canvas.loadCurrentSpec', () => {
  it('missing file -> null', async () => {
    expect(await registry.canvas.loadCurrentSpec()).toBeNull();
  });

  it('corrupt JSON -> null, no throw', async () => {
    writeFileSync(CANVAS_SPEC_PATH, '{"title": ');
    expect(await registry.canvas.loadCurrentSpec()).toBeNull();
  });

  it('valid file round-trips including the _historyId/_writtenAt envelope', async () => {
    const written = { ...spec('T'), _historyId: 'h1', _writtenAt: 1234 };
    writeFileSync(CANVAS_SPEC_PATH, JSON.stringify(written));
    expect(await registry.canvas.loadCurrentSpec()).toEqual(written);
  });
});

describe('canvas.updateSpec', () => {
  it('unknown history id is a no-op: history and current-spec file are untouched', async () => {
    const history = [entry('known', 'Old')];
    writeFileSync(CANVAS_HISTORY_PATH, JSON.stringify(history));
    const before = readFileSync(CANVAS_HISTORY_PATH, 'utf-8');
    await registry.canvas.updateSpec('unknown-id', spec('New'));
    expect(existsSync(CANVAS_SPEC_PATH)).toBe(false);
    expect(readFileSync(CANVAS_HISTORY_PATH, 'utf-8')).toBe(before);
  });

  it('unknown id does not clobber an existing current-spec file', async () => {
    writeFileSync(CANVAS_HISTORY_PATH, JSON.stringify([entry('known', 'Old')]));
    writeFileSync(CANVAS_SPEC_PATH, JSON.stringify({ ...spec('Current'), _historyId: 'known' }));
    const before = readFileSync(CANVAS_SPEC_PATH, 'utf-8');
    await registry.canvas.updateSpec('gone', spec('New'));
    expect(readFileSync(CANVAS_SPEC_PATH, 'utf-8')).toBe(before);
  });

  it('known id: history entry spec replaced AND current spec rewritten tagged with that id (persisted state)', async () => {
    writeFileSync(CANVAS_HISTORY_PATH, JSON.stringify([entry('other', 'Other'), entry('known', 'Old')]));
    await registry.canvas.updateSpec('known', spec('Edited'));
    const hist = loadHistory();
    expect(hist.map((e) => e.id)).toEqual(['other', 'known']);
    expect(hist[1].spec.title).toBe('Edited');
    expect(hist[1].updatedAt).toBeDefined();
    expect(hist[0].spec.title).toBe('Other'); // other entries untouched
    const cur = await registry.canvas.loadCurrentSpec();
    expect(cur).toMatchObject({ title: 'Edited', _historyId: 'known' });
    expect(typeof cur!._writtenAt).toBe('number');
  });
});

describe('profile.getHouseholdMembers', () => {
  it('no profile -> []', async () => {
    expect(await registry.profile.getHouseholdMembers()).toEqual([]);
  });

  it('maps self, spouse, children in order and drops blank/whitespace names (trimmed)', async () => {
    await saveProfile({
      self: { name: ' Thomas ', birthYear: 1985 },
      spouse: { name: 'Alex', birthYear: 1986 },
      children: [{ name: 'Kid1', birthYear: 2020 }, { name: '   ', birthYear: 2022 }],
    });
    expect(await registry.profile.getHouseholdMembers()).toEqual(['Thomas', 'Alex', 'Kid1']);
  });
});

describe('settings accessors', () => {
  it('absent keys read as null', async () => {
    expect(await registry.settings.getPretaxMonthly()).toBeNull();
    expect(await registry.settings.getBackupIncludeKey()).toBeNull();
  });

  it('round-trip and overwrite, independent keys', async () => {
    await registry.settings.setPretaxMonthly('1500');
    await registry.settings.setBackupIncludeKey('true');
    expect(await registry.settings.getPretaxMonthly()).toBe('1500');
    expect(await registry.settings.getBackupIncludeKey()).toBe('true');
    await registry.settings.setPretaxMonthly('2000');
    expect(await registry.settings.getPretaxMonthly()).toBe('2000');
    expect(await registry.settings.getBackupIncludeKey()).toBe('true');
  });
});

describe('config.writeEnv', () => {
  it('returns only { written } (no path leak), writes into the temp data dir', async () => {
    const out = await registry.config.writeEnv({ PLAID_CLIENT_ID: 'abc', EMPTY: '  ' });
    expect(out).toEqual({ written: ['PLAID_CLIENT_ID'] });
    expect(Object.keys(out)).toEqual(['written']);
    expect(readFileSync(`${h.dir}/.env`, 'utf8')).toContain('PLAID_CLIENT_ID=abc');
  });

  it('rejects an invalid key', async () => {
    await expect(registry.config.writeEnv({ 'bad key': 'x' })).rejects.toThrow(/Invalid env key/);
  });
});
