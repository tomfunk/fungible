import React from 'react';
import { render } from 'ink-testing-library';
import { expect } from 'vitest';
import { Accounts } from '../../../tui/Accounts.js';
import { waitFor, flatFrame } from '../../helpers/waitFor.js';
import { W, noop } from './screenSetup.js';

/** Renders the Accounts screen inside the providers App normally supplies. */
export function renderAccounts(overrides?: Partial<Parameters<typeof Accounts>[0]>) {
  return render(
    <W>
      <Accounts onNavigate={noop} showHints={false} {...overrides} />
    </W>,
  );
}

/**
 * Tab from Accounts to a named view, so tests don't hard-code how many tabs
 * sit between them. Asserting on view-specific content matters here: every
 * tab's label is in the header on every view, so waiting for "Add Data" would
 * pass without having navigated anywhere.
 */
const VIEW_MARKER = {
  links: 'connection',                 // Links panel footer, or its empty state
  'add-data': '[l] Link a bank account',
  dupes: 'duplicate',                  // "No duplicate candidates found." / "Checking for duplicates…"
} as const;

export async function tabTo(r: ReturnType<typeof render>, view: keyof typeof VIEW_MARKER) {
  const order = ['links', 'add-data', 'dupes'] as const;
  for (let i = 0; i <= order.indexOf(view); i++) {
    r.stdin.write('\t');
    // Consecutive writes coalesce into one chunk, which ink reads as a single
    // Tab — the gap keeps each press its own input event.
    await new Promise((res) => setTimeout(res, 10));
  }
  await waitFor(() => expect(flatFrame(r)).toContain(VIEW_MARKER[view]));
}
