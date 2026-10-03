import React from 'react';
import { it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { frameHasColor, useForcedColor, SGR } from './ansi.js';
useForcedColor();
it('ink', () => {
  const r = render(<Text color="yellow">hello</Text>);
  expect(frameHasColor(r.lastFrame(), 'hello', SGR.yellow)).toBe(true);
});
