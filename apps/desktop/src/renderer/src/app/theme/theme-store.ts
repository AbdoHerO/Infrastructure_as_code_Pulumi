import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ThemeMode } from '@cloudforge/shared';

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

/** Persisted UI theme preference. */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      setMode: (mode) => set({ mode }),
      toggle: () => set({ mode: resolve(get().mode) === 'dark' ? 'light' : 'dark' }),
    }),
    { name: 'cloudforge.theme' },
  ),
);

/** Resolve a theme mode against the OS preference into a concrete light/dark. */
export function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

/** Apply the resolved theme by toggling the `dark` class on the document root. */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolve(mode);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}
