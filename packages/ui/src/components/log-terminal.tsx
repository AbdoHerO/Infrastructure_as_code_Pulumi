import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn.js';

interface LogTerminalProps {
  lines: readonly string[];
  className?: string;
  emptyMessage?: string;
}

/** Terminal-style, auto-scrolling log viewer. */
export function LogTerminal({ lines, className, emptyMessage }: LogTerminalProps): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <div
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
      <div ref={endRef} />
    </div>
  );
}
