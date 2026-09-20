import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

export type PaletteName = 'default' | 'high-contrast' | 'deuteranopia' | 'protanopia' | 'monochrome';

// Table row density — how much vertical padding every data table (and the
// shared .tableRow/.tableHeaderRow utility classes, for whenever something
// uses those directly) gets. Same root-attribute + localStorage mechanism as
// theme/palette below; see theme.css's --table-row-padding /
// --table-header-padding-bottom, which every screen's table CSS reads from.
export type RowDensity = 'balanced' | 'compact';

type UiPrefs = {
  theme: Theme;
  toggleTheme: () => void;
  keys: boolean;
  toggleKeys: () => void;
  palette: PaletteName;
  setPalette: (p: PaletteName) => void;
  density: RowDensity;
  setDensity: (d: RowDensity) => void;
};

const Ctx = createContext<UiPrefs>({
  theme: 'dark',
  toggleTheme: () => {},
  keys: false,
  toggleKeys: () => {},
  palette: 'default',
  setPalette: () => {},
  density: 'balanced',
  setDensity: () => {},
});

const PALETTE_NAMES: PaletteName[] = ['default', 'high-contrast', 'deuteranopia', 'protanopia', 'monochrome'];
const DENSITY_NAMES: RowDensity[] = ['balanced', 'compact'];

function readPalette(): PaletteName {
  const stored = localStorage.getItem('fungible-palette');
  return (PALETTE_NAMES as string[]).includes(stored ?? '') ? (stored as PaletteName) : 'default';
}

function readDensity(): RowDensity {
  const stored = localStorage.getItem('fungible-density');
  return (DENSITY_NAMES as string[]).includes(stored ?? '') ? (stored as RowDensity) : 'balanced';
}

export function UiPrefsProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('fungible-theme') === 'light' ? 'light' : 'dark'));
  const [keys, setKeys] = useState<boolean>(() => localStorage.getItem('fungible-keys') === 'on');
  const [palette, setPalette] = useState<PaletteName>(readPalette);
  const [density, setDensity] = useState<RowDensity>(readDensity);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('fungible-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('fungible-keys', keys ? 'on' : 'off');
  }, [keys]);

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    localStorage.setItem('fungible-palette', palette);
  }, [palette]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem('fungible-density', density);
  }, [density]);

  return (
    <Ctx.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
        keys,
        toggleKeys: () => setKeys((k) => !k),
        palette,
        setPalette,
        density,
        setDensity,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useUiPrefs(): UiPrefs {
  return useContext(Ctx);
}
