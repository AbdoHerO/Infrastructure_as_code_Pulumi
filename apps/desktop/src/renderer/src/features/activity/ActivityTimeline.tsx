import { Activity, Boxes, Rocket, Server, type LucideIcon } from 'lucide-react';
import type { ActivityDto } from '@cloudforge/core';

function iconFor(type: string): LucideIcon {
  if (type.startsWith('project')) return Boxes;
  if (type.startsWith('deployment')) return Rocket;
  if (type.startsWith('infrastructure')) return Server;
  return Activity;
}

/** Relative "time ago" formatting for activity timestamps. */
export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Vertical timeline of activity entries. */
export function ActivityTimeline({ items }: { items: readonly ActivityDto[] }): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-1 py-12 text-center text-sm">
        <p>No activity yet.</p>
        <p className="text-xs">Provisioning, deployments and provider events appear here.</p>
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const Icon = iconFor(item.type);
        const failed = item.type.endsWith('failed');
        return (
          <li
            key={item.id}
            className="hover:bg-accent/40 flex items-center gap-3 rounded-lg px-2 py-2"
          >
            <div
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                failed ? 'bg-destructive/10 text-destructive' : 'bg-secondary text-muted-foreground'
              }`}
            >
              <Icon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{item.message}</p>
              <p className="text-muted-foreground text-xs">{item.type}</p>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">
              {timeAgo(item.createdAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
