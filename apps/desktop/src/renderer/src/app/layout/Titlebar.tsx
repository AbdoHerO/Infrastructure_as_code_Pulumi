import { CircleHelp, Monitor, Moon, Search, Sun } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@cloudforge/ui';
import type { ThemeMode } from '@cloudforge/shared';
import { useThemeStore } from '../theme/theme-store.js';
import { useCommandPalette } from '../command/command-store.js';

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const MODE_ICON = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

/** Draggable top bar hosting global search and the theme switcher. */
export function Titlebar(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const openPalette = useCommandPalette((s) => s.setOpen);
  const ModeIcon = MODE_ICON[mode];

  return (
    <header className="drag-region border-border/60 bg-background/80 flex h-12 shrink-0 items-center justify-between border-b px-4 backdrop-blur">
      <button
        type="button"
        onClick={() => openPalette(true)}
        className="no-drag border-input bg-secondary/50 text-muted-foreground hover:bg-secondary flex h-8 w-72 items-center gap-2 rounded-md border px-3 text-sm transition-colors"
      >
        <Search className="size-3.5" />
        <span>Search or run a command…</span>
        <kbd className="bg-background text-muted-foreground ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium">
          ⌘K
        </kbd>
      </button>

      <div className="no-drag flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          title="Open help for this page"
          aria-label="Open contextual documentation"
          onClick={() => navigate(`/documentation?doc=${documentationFor(location.pathname)}`)}
        >
          <CircleHelp className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={`Theme: ${mode}`}
          onClick={() => setMode(NEXT_MODE[mode])}
        >
          <ModeIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function documentationFor(pathname: string): string {
  if (pathname.startsWith('/infrastructure')) return 'first-instance';
  if (pathname.startsWith('/ansible')) return 'ansible';
  if (pathname.startsWith('/nginx')) return 'nginx-manager';
  if (pathname.startsWith('/firewall')) return 'firewall-manager';
  if (pathname.startsWith('/ssl')) return 'ssl-domains';
  if (pathname.startsWith('/providers') || pathname.startsWith('/secrets')) return 'configuration';
  if (pathname.startsWith('/updates')) return 'moving-and-releasing';
  if (pathname.startsWith('/settings')) return 'configuration';
  return 'getting-started';
}
