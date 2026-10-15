import { describe, it, expect } from 'vitest';
import { describeError, UNREACHABLE_MESSAGE } from '../../gui/shared/account-types.js';

describe('describeError', () => {
  it('unwraps the Electron IPC prefix and maps fetch failures to a friendly message, keeping the raw detail', () => {
    const e = new Error("Error invoking remote method 'bridge:call': TypeError: fetch failed");
    expect(describeError(e)).toEqual({ message: UNREACHABLE_MESSAGE, detail: 'fetch failed', network: true });
  });

  it.each(['Failed to fetch', 'connect ECONNREFUSED 127.0.0.1:3000', 'getaddrinfo ENOTFOUND sync.test'])(
    'treats %s as unreachable', (m) => {
      expect(describeError(new TypeError(m))).toMatchObject({ message: UNREACHABLE_MESSAGE, network: true });
    },
  );

  it('strips wrappers from ordinary errors without hiding the message', () => {
    expect(describeError(new Error("Error invoking remote method 'bridge:call': Error: Invalid email or password")))
      .toEqual({ message: 'Invalid email or password', detail: 'Invalid email or password', network: false });
    expect(describeError('plain string')).toMatchObject({ message: 'plain string', network: false });
    expect(describeError(new Error(''))).toMatchObject({ message: 'Unknown error' });
  });
});
