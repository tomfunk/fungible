import { vi } from 'vitest';

/**
 * Scripted fakes for paid/slow external providers. No network, no timers.
 * Each call consumes the next scripted response; a response may be a value, a
 * function of the request, or an Error (rejects). Calls past the end of the
 * script repeat the last response, so single-response tests stay one-liners.
 */
type Step<Req, Res> = Res | Error | ((req: Req) => Res | Promise<Res>);

function scripted<Req, Res>(steps: Step<Req, Res>[]) {
  let i = 0;
  return vi.fn(async (req: Req): Promise<Res> => {
    if (steps.length === 0) throw new Error('fake provider: no scripted response');
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? (step as (r: Req) => Res | Promise<Res>)(req) : step;
  });
}

export interface PlaidSyncPage {
  added?: object[];
  modified?: object[];
  removed?: string[];
  /** Defaults to cursor-N. */
  next_cursor?: string;
}

/**
 * Fake Plaid client. `pages` are transactionsSync responses in order;
 * has_more is derived (true on every page but the last), matching real
 * pagination. Pass an Error as a page to simulate a mid-sync failure.
 * Wire it with: vi.mocked(getPlaidClient).mockReturnValue(plaid as never)
 */
export function makeFakePlaid(opts: { pages?: (PlaidSyncPage | Error)[]; accounts?: object[] } = {}) {
  const pages = opts.pages ?? [{}];
  let call = 0;
  const transactionsSync = vi.fn(async () => {
    const idx = Math.min(call++, pages.length - 1);
    const p = pages[idx];
    if (p instanceof Error) throw p;
    return {
      data: {
        added: p.added ?? [],
        modified: p.modified ?? [],
        removed: (p.removed ?? []).map((id) => ({ transaction_id: id })),
        has_more: idx < pages.length - 1,
        next_cursor: p.next_cursor ?? `cursor-${idx + 1}`,
      },
    };
  });
  const accountsGet = vi.fn(async () => ({ data: { accounts: opts.accounts ?? [] } }));
  return { transactionsSync, accountsGet };
}

/**
 * Fake LLM provider returning scripted text. `calls` records each request so
 * a test can assert on the prompt without a network round-trip.
 */
export function makeFakeLlm(responses: Step<unknown, string>[] = ['']) {
  const complete = scripted<unknown, string>(responses);
  return { complete, calls: () => complete.mock.calls.map((c) => c[0]) };
}
