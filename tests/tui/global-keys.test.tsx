import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

const { exitSpy } = vi.hoisted(() => ({ exitSpy: vi.fn() }));

// Only useApp is replaced (so `q` can be observed without tearing down the
// test renderer); input handling, layout and rendering stay real.
vi.mock('ink', async (importActual) => {
  const actual = await importActual<typeof import('ink')>();
  return { ...actual, useApp: () => ({ exit: exitSpy }) };
});

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { App } from '../../tui/App.js';
import { waitFor, frame, press, pressKeys } from '../helpers/waitFor.js';
import { useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();
beforeEach(() => exitSpy.mockClear());

async function mount() {
  const r = render(<App />);
  await waitFor(() => expect(frame(r)).toContain('SPENDING BY CATEGORY'));
  return r;
}

describe('App global keys', () => {
  it('q exits the app', async () => {
    const r = await mount();
    expect(exitSpy).not.toHaveBeenCalled();
    await press(r, 'q');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('q does not exit while a screen is taking text input', async () => {
    const r = await mount();
    await pressKeys(r, ['2', '/']);
    await waitFor(() => expect(frame(r)).toContain('Transactions'));
    await press(r, 'q');
    await waitFor(() => expect(frame(r)).toMatch(/\/\s*q/));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('backtick focuses chat, which owns the keyboard until Esc', async () => {
    const r = await mount();
    expect(frame(r)).not.toContain('[Esc] back to app');

    await press(r, '`');
    await waitFor(() => expect(frame(r)).toContain('[Esc] back to app'));

    // Digits and q are chat input now, not navigation / quit.
    await press(r, '2');
    await press(r, 'q');
    expect(exitSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(frame(r)).toContain('2q'));
    expect(frame(r)).toContain('Dashboard');
    expect(frame(r)).not.toContain('DESCRIPTION');

    // First Esc clears the typed text, the second closes chat.
    await press(r, '\x1B');
    await waitFor(() => expect(frame(r)).not.toContain('2q'));
    await press(r, '\x1B');
    await waitFor(() => expect(frame(r)).not.toContain('[Esc] back to app'));

    await press(r, '2');
    await waitFor(() => expect(frame(r)).toContain('DESCRIPTION'));
    expect(frame(r)).not.toContain('Dashboard');
  });
});
