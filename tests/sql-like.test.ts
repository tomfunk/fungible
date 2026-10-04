import { describe, it, expect } from 'vitest';
import { escapeLike } from '../core/sql-like.js';

describe('escapeLike', () => {
  it.each([
    ['plain', 'plain'],
    ['100%', '100\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['%_\\', '\\%\\_\\\\'],
    ['a%b_c\\d', 'a\\%b\\_c\\\\d'],
    ['', ''],
  ])('escapes %j -> %j', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });
});
