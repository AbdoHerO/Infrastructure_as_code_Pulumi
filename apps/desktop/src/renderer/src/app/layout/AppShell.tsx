import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar.js';
import { Titlebar } from './Titlebar.js';
import { applyTheme, useThemeStore } from '../theme/theme-store.js';

/** Root application chrome: sidebar rail, draggable titlebar and routed content. */
export function AppShell(): JSX.Element {
  const mode = useThemeStore((s) => s.mode);

  useEffect(() => {
    applyTheme(mode);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme(mode);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  return (
    <div className="bg-background text-foreground flex h-full w-full overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Titlebar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-8 py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
