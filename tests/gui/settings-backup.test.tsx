// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { vi } from 'vitest';
vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Settings } from '../../gui/renderer/src/screens/Settings.js';

const storedValue = async (key: string) => {
  const { rows } = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return (rows[0] as unknown as { value: string } | undefined)?.value;
};

const checkbox = () => screen.getByRole('checkbox') as HTMLInputElement;

beforeEach(async () => {
  for (const tbl of ['settings', 'household_members']) await db.execute(`DELETE FROM ${tbl}`);
  installBridge();
});

afterEach(() => cleanup());

describe('GUI Settings — backup key toggle', () => {
  it('defaults off, with an explanation of what it does', async () => {
    renderScreen(<Settings />);
    await waitFor(() => expect(screen.getByText('Include encryption key')).toBeTruthy());
    expect(checkbox().checked).toBe(false);
    expect(
      screen.getByText(
        /Your encryption key protects your linked banks\. Off by default — turning this on includes it in your daily backups\./,
      ),
    ).toBeTruthy();
    // Nothing written until the user opts in.
    expect(await storedValue('backup_include_key')).toBeUndefined();
  });

  it('turning it on persists the setting', async () => {
    renderScreen(<Settings />);
    await waitFor(() => expect(screen.getByText('Include encryption key')).toBeTruthy());

    await userEvent.click(checkbox());

    await waitFor(async () => expect(await storedValue('backup_include_key')).toBe('true'));
    expect(checkbox().checked).toBe(true);
  });

  it('reflects a previously saved "on" setting', async () => {
    await db.execute({
      sql: `INSERT INTO settings (key, value) VALUES ('backup_include_key', 'true')`,
      args: [],
    });

    renderScreen(<Settings />);

    await waitFor(() => expect(checkbox().checked).toBe(true));
  });

  it('turning it back off persists the change', async () => {
    await db.execute({
      sql: `INSERT INTO settings (key, value) VALUES ('backup_include_key', 'true')`,
      args: [],
    });
    renderScreen(<Settings />);
    await waitFor(() => expect(checkbox().checked).toBe(true));

    await userEvent.click(checkbox());

    await waitFor(async () => expect(await storedValue('backup_include_key')).toBe('false'));
    expect(checkbox().checked).toBe(false);
  });
});
