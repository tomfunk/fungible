import { describe, it, expect, afterEach } from 'vitest';
import { applyTheme, THEMES, THEME_NAMES } from '../../tui/ui.js';
import * as ui from '../../tui/ui.js';

// ui.ts exports the C_* constants as `let` bindings reassigned in place by
// applyTheme() so every existing `color={C_POSITIVE}` call site picks up the
// change via ESM live bindings. Always reset to 'default' afterward so this
// module-level mutable state doesn't leak into other test files that import
// tui/ui.js in the same worker.
afterEach(() => { applyTheme('default'); });

describe('applyTheme', () => {
  it('starts on the default palette', () => {
    expect(ui.C_POSITIVE).toBe(THEMES.default.positive);
    expect(ui.C_NEGATIVE).toBe(THEMES.default.negative);
    expect(ui.FLEX_COLORS).toEqual(THEMES.default.flex);
  });

  it('reassigns the C_* constants and FLEX_COLORS for a known theme', () => {
    applyTheme('deuteranopia');
    expect(ui.C_POSITIVE).toBe(THEMES.deuteranopia.positive);
    expect(ui.C_NEGATIVE).toBe(THEMES.deuteranopia.negative);
    expect(ui.C_WARNING).toBe(THEMES.deuteranopia.warning);
    expect(ui.C_NEUTRAL).toBe(THEMES.deuteranopia.neutral);
    expect(ui.C_MANUAL).toBe(THEMES.deuteranopia.manual);
    expect(ui.C_ACCENT).toBe(THEMES.deuteranopia.accent);
    expect(ui.C_DIM).toBe(THEMES.deuteranopia.dim);
    expect(ui.FLEX_COLORS).toEqual(THEMES.deuteranopia.flex);
  });

  it('deuteranopia and protanopia both remap red/green to blue/orange', () => {
    applyTheme('protanopia');
    expect(ui.C_POSITIVE).toBe(THEMES.deuteranopia.positive);
    expect(ui.C_NEGATIVE).toBe(THEMES.deuteranopia.negative);
  });

  it('restores the original values when switching back to default', () => {
    applyTheme('high-contrast');
    expect(ui.C_POSITIVE).toBe(THEMES['high-contrast'].positive);
    applyTheme('default');
    expect(ui.C_POSITIVE).toBe(THEMES.default.positive);
    expect(ui.C_NEGATIVE).toBe(THEMES.default.negative);
    expect(ui.C_WARNING).toBe(THEMES.default.warning);
    expect(ui.C_NEUTRAL).toBe(THEMES.default.neutral);
    expect(ui.C_MANUAL).toBe(THEMES.default.manual);
    expect(ui.C_ACCENT).toBe(THEMES.default.accent);
    expect(ui.C_DIM).toBe(THEMES.default.dim);
    expect(ui.FLEX_COLORS).toEqual(THEMES.default.flex);
  });

  it('falls back to default for an unknown theme name', () => {
    applyTheme('not-a-real-theme');
    expect(ui.C_POSITIVE).toBe(THEMES.default.positive);
    expect(ui.FLEX_COLORS).toEqual(THEMES.default.flex);
  });

  it('lists every THEMES key in THEME_NAMES', () => {
    expect(THEME_NAMES.sort()).toEqual(Object.keys(THEMES).sort());
  });
});
