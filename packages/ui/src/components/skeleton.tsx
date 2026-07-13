import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

/** Shimmering placeholder used for loading states. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div className={cn('bg-muted relative overflow-hidden rounded-md', className)} {...props}>
      <div className="animate-shimmer via-foreground/5 absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent to-transparent" />
    </div>
  );
}
