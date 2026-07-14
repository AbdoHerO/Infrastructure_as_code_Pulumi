import { useLayoutEffect, useRef, type UIEvent } from 'react';
import { cn } from '../lib/cn.js';

interface LogTerminalProps {
  lines: readonly string[];
  className?: string;
  emptyMessage?: string;
}

const AUTO_SCROLL_THRESHOLD_PX = 32;

export interface TerminalViewport {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

/** Whether the reader is close enough to the end for new output to follow. */
export function isTerminalNearBottom(
  viewport: TerminalViewport,
  threshold = AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}

/** Terminal-style log viewer that scrolls only its own viewport. */
export function LogTerminal({ lines, className, emptyMessage }: LogTerminalProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const previousLineCountRef = useRef(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (lines.length < previousLineCountRef.current) followOutputRef.current = true;
    if (followOutputRef.current) viewport.scrollTop = viewport.scrollHeight;
    previousLineCountRef.current = lines.length;
  }, [lines.length]);

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    followOutputRef.current = isTerminalNearBottom(event.currentTarget);
  };

  return (
    <div
      ref={viewportRef}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      className={cn(
        'border-border h-72 overflow-y-auto rounded-lg border bg-[#0a0a0b] p-3 font-mono text-xs leading-relaxed text-neutral-200',
        className,
      )}
    >
      {lines.length === 0 ? (
        <p className="text-neutral-500">{emptyMessage ?? 'No output yet.'}</p>
      ) : (
        lines.map((line, index) => (
          <div key={index} className="whitespace-pre-wrap break-all">
            {line}
          </div>
        ))
      )}
    </div>
  );
}
