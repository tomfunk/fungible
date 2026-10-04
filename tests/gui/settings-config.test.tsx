// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Keep config.writeEnv off the real ~/.fungible/.env. Must precede registry/core imports.
vi.mock('../../core/paths.js', async () => ({
  DATA_DIR: (await import('../helpers/tempDataDir.js')).tempDataDir.dir,
}));
vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { tempDataDir } from '../helpers/tempDataDir.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Settings } from '../../gui/renderer/src/screens/Settings.js';

type Bridge = { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> };

const field = (label: string) =>
  screen.getByText(label).closest('div')!.querySelector('input, select') as HTMLInputElement & HTMLSelectElement;
const saveBtn = () => screen.getByRole('button', { name: 'Save to .env' }) as HTMLButtonElement;

async function renderLoaded() {
  renderScreen(<Settings />);
  await waitFor(() => expect(screen.getByText('Configuration')).toBeTruthy());
}

beforeEach(async () => {
  tempDataDir.reset();
  await db.execute('DELETE FROM household_members');
  installBridge();
});

afterEach(() => cleanup());
afterAll(() => tempDataDir.cleanup());

describe('GUI Settings — configuration (.env)', () => {
  it('starts with Save disabled, secrets masked, and "(unchanged)" placeholders', async () => {
    await renderLoaded();
    expect(saveBtn().disabled).toBe(true);
    expect(field('Plaid Client ID').type).toBe('text');
    for (const label of ['Plaid Secret', 'Anthropic API Key', 'OpenAI API Key']) {
      expect(field(label).type).toBe('password');
    }
    for (const label of ['Plaid Client ID', 'Plaid Secret', 'Anthropic API Key', 'OpenAI API Key']) {
      expect(field(label).placeholder).toBe('(unchanged)');
      expect(field(label).value).toBe('');
    }
    expect(field('Plaid Environment').value).toBe('');
  });

  it('does not echo values that are already in the .env file', async () => {
    fs.writeFileSync(tempDataDir.envPath, 'ANTHROPIC_API_KEY=sk-existing-secret\nPLAID_ENV=production\n');
    await renderLoaded();
    expect(field('Anthropic API Key').value).toBe('');
    expect(field('Plaid Environment').value).toBe('');
    expect(document.body.textContent).not.toContain('sk-existing-secret');
    expect(saveBtn().disabled).toBe(true);
  });

  it('saves two values, writes them to the env file, clears the inputs and never shows the secret', async () => {
    await renderLoaded();
    await userEvent.type(field('Plaid Client ID'), 'client-123');
    await userEvent.type(field('Anthropic API Key'), 'sk-ant-supersecret');
    expect(saveBtn().disabled).toBe(false);
    await userEvent.click(saveBtn());

    await waitFor(() => expect(screen.getByText('Saved 2 values · restart to apply')).toBeTruthy());
    const env = tempDataDir.readEnv();
    expect(env).toContain('PLAID_CLIENT_ID=client-123');
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-supersecret');
    expect(env).not.toContain('PLAID_SECRET');
    expect(field('Plaid Client ID').value).toBe('');
    expect(field('Anthropic API Key').value).toBe('');
    expect(document.body.textContent).not.toContain('sk-ant-supersecret');
    expect(saveBtn().disabled).toBe(true);
  });

  it('uses the singular for one saved value', async () => {
    await renderLoaded();
    await userEvent.type(field('OpenAI API Key'), 'sk-openai');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Saved 1 value · restart to apply')).toBeTruthy());
    expect(tempDataDir.readEnv()).toBe('OPENAI_API_KEY=sk-openai\n');
  });

  it('picking a Plaid environment enables Save and writes PLAID_ENV; reverting to "(unchanged)" disables it', async () => {
    await renderLoaded();
    await userEvent.selectOptions(field('Plaid Environment'), 'sandbox');
    expect(saveBtn().disabled).toBe(false);
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Saved 1 value · restart to apply')).toBeTruthy());
    expect(tempDataDir.readEnv()).toContain('PLAID_ENV=sandbox');
    expect(field('Plaid Environment').value).toBe(''); // reset after save

    await userEvent.selectOptions(field('Plaid Environment'), 'production');
    expect(saveBtn().disabled).toBe(false);
    await userEvent.selectOptions(field('Plaid Environment'), '');
    expect(saveBtn().disabled).toBe(true);
  });

  it('merges into an existing file: keeps comments and unrelated keys, replaces in place, no duplicates', async () => {
    fs.writeFileSync(tempDataDir.envPath, '# my comment\nFOO=1\nANTHROPIC_API_KEY=old\nBAR=2\n');
    await renderLoaded();
    await userEvent.type(field('Anthropic API Key'), 'new-key');
    await userEvent.type(field('Plaid Client ID'), 'cid');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Saved 2 values · restart to apply')).toBeTruthy());

    const lines = tempDataDir.readEnv().trim().split('\n');
    expect(lines).toEqual(['# my comment', 'FOO=1', 'ANTHROPIC_API_KEY=new-key', 'BAR=2', 'PLAID_CLIENT_ID=cid']);
    expect(tempDataDir.readEnv()).not.toContain('old');
  });

  it('on failure shows the reason, keeps the typed values, and re-enables the button', async () => {
    await renderLoaded();
    const b = (window as unknown as { __bridge: Bridge }).__bridge;
    const prev = b.call;
    b.call = async (ns, fn, args) => {
      if (ns === 'config' && fn === 'writeEnv') throw new Error('disk full');
      return prev(ns, fn, args);
    };
    await userEvent.type(field('Plaid Client ID'), 'client-123');
    await userEvent.type(field('Anthropic API Key'), 'sk-keep-me');
    await userEvent.click(saveBtn());

    await waitFor(() => expect(screen.getByText('Save failed: disk full')).toBeTruthy());
    expect(field('Plaid Client ID').value).toBe('client-123');
    expect(field('Anthropic API Key').value).toBe('sk-keep-me');
    expect(saveBtn().disabled).toBe(false);
    expect(saveBtn().textContent).toBe('Save to .env');
    expect(tempDataDir.readEnv()).toBe('');
  });

  it('a whitespace-only value keeps Save disabled', async () => {
    await renderLoaded();
    await userEvent.type(field('Plaid Secret'), '   ');
    expect(saveBtn().disabled).toBe(true);
    await userEvent.type(field('Plaid Secret'), 'real');
    expect(saveBtn().disabled).toBe(false);
  });

  it('values are trimmed when written', async () => {
    await renderLoaded();
    await userEvent.type(field('Plaid Client ID'), '  padded  ');
    await userEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('Saved 1 value · restart to apply')).toBeTruthy());
    expect(tempDataDir.readEnv()).toBe('PLAID_CLIENT_ID=padded\n');
  });
});
