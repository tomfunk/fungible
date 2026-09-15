import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

export type PaletteName = 'default' | 'high-contrast' | 'deuteranopia' | 'protanopia' | 'monochrome';

type UiPrefs = {
  theme: Theme;
  toggleTheme: () => void;
  keys: boolean;
  toggleKeys: () => void;
  palette: PaletteName;
  setPalette: (p: PaletteName) => void;
};

const Ctx = createContext<UiPrefs>({
  theme: 'dark',
  toggleTheme: () => {},
  keys: false,
  toggleKeys: () => {},
  palette: 'default',
  setPalette: () => {},
});

const PALETTE_NAMES: PaletteName[] = ['default', 'high-contrast', 'deuteranopia', 'protanopia', 'monochrome'];

function readPalette(): PaletteName {
  const stored = localStorage.getItem('fungible-palette');
  return (PALETTE_NAMES as string[]).includes(stored ?? '') ? (stored as PaletteName) : 'default';
}

export function UiPrefsProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('fungible-theme') === 'light' ? 'light' : 'dark'));
  const [keys, setKeys] = useState<boolean>(() => localStorage.getItem('fungible-keys') === 'on');
  const [palette, setPalette] = useState<PaletteName>(readPalette);

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

  return (
    <Ctx.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
        keys,
        toggleKeys: () => setKeys((k) => !k),
        palette,
        setPalette,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useUiPrefs(): UiPrefs {
  return useContext(Ctx);
}
