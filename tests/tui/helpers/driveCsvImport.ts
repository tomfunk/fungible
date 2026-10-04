import type { render } from 'ink-testing-library';
import { expect } from 'vitest';
import { waitFor, flatFrame as flat, pressAndWait } from '../../helpers/waitFor.js';

type R = Pick<ReturnType<typeof render>, 'stdin' | 'lastFrame'>;

const DOWN = '\u001b[B';

/**
 * Drivers for the CSV import flows on the Accounts screen's Add Data tab.
 * They only navigate; every assertion about what the screens say or what got
 * written stays in the test.
 */

/** Tab twice: Accounts -> Links -> Add Data (where imports and history live). */
export async function toAddData(r: R, landingMarker = 'Import CSV file') {
  // One tab at a time: two writes in the same tick land as one chunk and Ink
  // processes only the first.
  await pressAndWait(r, '\t', 'Links');
  await pressAndWait(r, '\t', landingMarker);
}

/** Types a file path into the open path field, waits for it to echo, and presses Enter. */
export async function typePath(r: R, path: string) {
  r.stdin.write(path); // one chunk: no coalescing concern, and far faster than per-key presses
  await new Promise((res) => setTimeout(res, 15));
  await waitFor(() => expect(flat(r)).toContain(path.slice(-12)));
  r.stdin.write('\r');
}

/** Add Data -> [b] -> the balance history file prompt. */
export async function toBalanceHistoryFile(r: R) {
  await toAddData(r, '[b] Import balance history');
  await pressAndWait(r, 'b', 'amount owed as a positive number');
}

/** Add Data -> [c] -> the transaction CSV file prompt. */
export async function toCsvFile(r: R) {
  await toAddData(r);
  await pressAndWait(r, 'c', 'path to your CSV file');
}

/**
 * Drives a Date,Description,Amount file through the transaction import wizard
 * to its "Ready to import" preview, accepting the defaults the wizard offers:
 * date and description columns as detected, a single signed Amount column
 * where a positive number is spending, into the first account listed.
 * Needs at least one account to exist.
 */
export async function toCsvPreview(r: R, path: string) {
  await toCsvFile(r);
  await typePath(r, path);
  await waitFor(() => expect(flat(r)).toContain('Which column is the DATE?'));
  await pressAndWait(r, '\r', 'Which column is the DESCRIPTION');
  await pressAndWait(r, '\r', 'How is the amount structured?');
  await pressAndWait(r, 's', 'Which column is the AMOUNT?');
  await pressAndWait(r, DOWN, '▶ Description');
  await pressAndWait(r, DOWN, '▶ Amount');
  await pressAndWait(r, '\r', 'does a positive number mean');
  await pressAndWait(r, 'o', 'Which account do these');
  await pressAndWait(r, '\r', 'Ready to import');
}
