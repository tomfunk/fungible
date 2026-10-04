import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

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

import { Settings } from '../../tui/Settings.js';
import { waitFor as baseWaitFor, frame } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';
import { loadProfile, saveProfile } from '../../core/profile.js';

useSeededScreenDb();

describe('Settings', () => {
  function settings(overrides?: Partial<Parameters<typeof Settings>[0]>) {
    return render(
      <W>
        <Settings onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders Settings heading and section labels', () => {
    const r = settings();
    const f = frame(r);
    expect(f).toContain('Settings');
    expect(f).toContain('HOUSEHOLD');
    expect(f).toContain('SPOUSE');
    expect(f).toContain('CHILDREN');
    expect(f).toContain('Your name');
    expect(f).toContain('Birth year');
  });

  it('Enter on a field opens edit mode showing cursor', async () => {
    const r = settings();
    expect(frame(r)).not.toContain('▊');
    r.stdin.write('\r'); // Enter on "Your name" (cursor starts at row 0)
    await waitFor(() => expect(frame(r)).toContain('▊'));
  });

  it('typing in edit mode accumulates in the buffer', async () => {
    const r = settings();
    r.stdin.write('\r');       // open edit on "Your name"
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Tom');
    await waitFor(() => {
      expect(frame(r)).toContain('Tom');
      expect(frame(r)).toContain('▊');
    });
  });

  it('Enter commits the edit and exits edit mode', async () => {
    const r = settings();
    r.stdin.write('\r');       // open
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Alice');
    await waitFor(() => expect(frame(r)).toContain('Alice')); // wait for buffer to render
    r.stdin.write('\r');       // commit with fresh closure
    await waitFor(() => {
      expect(frame(r)).toContain('Alice');
      expect(frame(r)).not.toContain('▊');
    });
  });

  it('Esc cancels edit without committing', async () => {
    const r = settings();
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Alice');
    r.stdin.write('\x1b');    // cancel
    await waitFor(() => {
      expect(frame(r)).not.toContain('Alice');
      expect(frame(r)).not.toContain('▊');
    });
  });

  it('[a] adds spouse fields when no spouse exists', async () => {
    const r = settings();
    expect(frame(r)).not.toContain('Spouse name');
    r.stdin.write('a');       // [a] adds spouse from any cursor position
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
  });

  it('[d] on spouse row removes spouse', async () => {
    const r = settings();
    r.stdin.write('a');                 // add spouse
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
    r.stdin.write('\x1B[B');            // ↓ to row 1 (self-year)
    r.stdin.write('\x1B[B');            // ↓ to row 2 (spouse-name)
    // Wait for re-render to commit cursor position before pressing 'd'
    await waitFor(() => expect(frame(r)).toContain('[d] remove spouse'));
    r.stdin.write('d');                 // remove spouse
    await waitFor(() => expect(frame(r)).not.toContain('Spouse name'));
  });

  it('Esc navigates back to dashboard', async () => {
    const onNavigate = vi.fn();
    const r = render(<W><Settings onNavigate={onNavigate} showHints={false} /></W>);
    r.stdin.write('\x1b');
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard'));
  });

  it('loaded profile values appear after async init', async () => {
    vi.mocked(loadProfile).mockResolvedValue({ self: { name: 'Thomas', birthYear: 1990 }, children: [] });
    const r = settings();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Thomas');
      expect(f).toContain('1990');
    });
  });

  it('committing a name edit calls saveProfile with the updated value', async () => {
    vi.mocked(saveProfile).mockClear();
    const r = settings();
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Alice');
    await waitFor(() => expect(frame(r)).toContain('Alice'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).not.toContain('▊'));
    expect(vi.mocked(saveProfile)).toHaveBeenCalledWith(
      expect.objectContaining({ self: expect.objectContaining({ name: 'Alice' }) }),
    );
  });

  it('[a] when spouse exists adds a child row', async () => {
    const r = settings();
    r.stdin.write('a');           // add spouse (no spouse yet)
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
    r.stdin.write('a');           // add child (spouse now exists)
    await waitFor(() => expect(frame(r)).toContain('Child 1'));
  });

  it('[d] on a child row removes it', async () => {
    const r = settings();
    r.stdin.write('a');           // add spouse
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
    r.stdin.write('a');           // add child → rows: self-name(0) self-year(1) spouse-name(2) spouse-year(3) child-0-name(4)
    await waitFor(() => expect(frame(r)).toContain('Child 1'));
    r.stdin.write('\x1B[B');      // ↓ → row 1
    r.stdin.write('\x1B[B');      // ↓ → row 2
    r.stdin.write('\x1B[B');      // ↓ → row 3
    r.stdin.write('\x1B[B');      // ↓ → row 4 (Child 1 name)
    await waitFor(() => expect(frame(r)).toContain('[d] remove'));
    r.stdin.write('d');
    await waitFor(() => expect(frame(r)).not.toContain('Child 1'));
  });

  it('birth year field rejects out-of-range years', async () => {
    const r = settings();
    r.stdin.write('\x1B[B');      // ↓ to self-year (row 1)
    r.stdin.write('\r');          // open edit
    await waitFor(() => expect(frame(r)).toContain('▊'));
    // Write digits individually — numeric fields check /^\d$/ per keypress
    for (const d of '1800') r.stdin.write(d);
    await waitFor(() => expect(frame(r)).toContain('1800')); // buffer visible while editing
    r.stdin.write('\r');          // commit — rejected because 1800 < 1900
    await waitFor(() => expect(frame(r)).not.toContain('▊'));
    expect(frame(r)).not.toContain('1800');
  });

  it('birth year field accepts years in range', async () => {
    const r = settings();
    r.stdin.write('\x1B[B');      // ↓ to self-year (row 1)
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
    for (const d of '1990') r.stdin.write(d);
    await waitFor(() => expect(frame(r)).toContain('1990')); // buffer visible while editing
    r.stdin.write('\r');
    await waitFor(() => {
      expect(frame(r)).toContain('1990');
      expect(frame(r)).not.toContain('▊');
    });
  });

  it('renders an APPEARANCE section with a Theme row defaulting to Default', () => {
    const r = settings();
    const f = frame(r);
    expect(f).toContain('APPEARANCE');
    expect(f).toContain('Theme');
    expect(f).toContain('Default');
  });

  it('left/right on the Theme row cycles themes and shows the restart hint', async () => {
    const r = settings();
    // self-name(0) -> self-year(1) -> add-spouse(2) -> add-child(3) -> theme(4)
    for (let i = 0; i < 4; i++) r.stdin.write('\x1B[B');
    await waitFor(() => expect(frame(r)).toContain('restart to apply'));
    r.stdin.write('\x1B[C'); // right arrow
    await waitFor(() => expect(frame(r)).toContain('High Contrast'));
    r.stdin.write('\x1B[D'); // left arrow back
    await waitFor(() => expect(frame(r)).toContain('Default'));
  });

  it('persists the theme choice and reloads it on remount', async () => {
    const r = settings();
    for (let i = 0; i < 4; i++) r.stdin.write('\x1B[B');
    await waitFor(() => expect(frame(r)).toContain('restart to apply'));
    r.stdin.write('\x1B[C'); // -> high-contrast
    await waitFor(() => expect(frame(r)).toContain('High Contrast'));
    cleanup();

    const r2 = settings();
    await waitFor(() => expect(frame(r2)).toContain('High Contrast'));
  });

  // Issue #179: the ~/.fungible/key file decrypts linked Plaid tokens, so it's
  // opt-in-only in backups (bundling it with the encrypted data it protects
  // defeats the point for anyone whose backup folder leaves the machine).
  it('renders a BACKUP section with the include-key toggle defaulting to Off', () => {
    const r = settings();
    const f = frame(r);
    expect(f).toContain('BACKUP');
    expect(f).toContain('Include key');
    expect(f).toContain('Off');
  });

  it('left/right on the include-key row toggles it On and shows the toggle hint', async () => {
    const r = settings();
    // self-name(0) -> self-year(1) -> add-spouse(2) -> add-child(3) -> theme(4) -> backup-include-key(5)
    for (let i = 0; i < 5; i++) r.stdin.write('\x1B[B');
    await waitFor(() => expect(frame(r)).toContain('←→ toggle'));
    r.stdin.write('\x1B[C'); // right arrow
    await waitFor(() => expect(frame(r)).toContain('On'));
    r.stdin.write('\x1B[D'); // left arrow back
    await waitFor(() => expect(frame(r)).toContain('Off'));
  });

  it('persists the include-key toggle and reloads it on remount', async () => {
    const r = settings();
    for (let i = 0; i < 5; i++) r.stdin.write('\x1B[B');
    await waitFor(() => expect(frame(r)).toContain('←→ toggle'));
    r.stdin.write('\x1B[C'); // -> On
    await waitFor(() => expect(frame(r)).toContain('On'));
    cleanup();

    const r2 = settings();
    await waitFor(() => expect(frame(r2)).toContain('On'));
  });
});
