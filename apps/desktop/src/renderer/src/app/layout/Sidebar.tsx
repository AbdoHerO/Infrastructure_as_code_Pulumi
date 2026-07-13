import { NavLink } from 'react-router-dom';
import { cn } from '@cloudforge/ui';
import { APP } from '@cloudforge/shared';
import { NAVIGATION } from '../navigation.js';

/** Fixed navigation rail listing every application module, grouped by concern. */
export function Sidebar(): JSX.Element {
  return (
    <aside className="border-sidebar-border bg-sidebar flex h-full w-60 shrink-0 flex-col border-r">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <div className="bg-primary text-primary-foreground shadow-glow flex size-8 items-center justify-center rounded-lg">
          <span className="text-sm font-bold">CF</span>
        </div>
        <div className="leading-tight">
          <p className="text-sidebar-foreground text-sm font-semibold">{APP.name}</p>
          <p className="text-muted-foreground text-[11px]">{APP.subtitle}</p>
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-2">
        {NAVIGATION.map((group) => (
          <div key={group.title}>
            <p className="text-muted-foreground/70 px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider">
              {group.title}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) =>
                      cn(
                        'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-foreground'
                          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                      )
                    }
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-sidebar-border border-t px-5 py-3">
        <p className="text-muted-foreground text-[11px]">v{APP.version}</p>
      </div>
    </aside>
  );
}
