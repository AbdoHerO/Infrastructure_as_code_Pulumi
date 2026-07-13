type Level = 'error' | 'warn' | 'info';

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Forward a message to the main-process application log (best-effort). */
function report(level: Level, message: string, stack?: string, source?: string): void {
  try {
    void window.cloudforge.invoke('logs:report', {
      level,
      message,
      ...(stack ? { stack } : {}),
      ...(source ? { source } : {}),
    });
  } catch {
    // Logging must never throw.
  }
}

/**
 * Route renderer errors, unhandled rejections and `console.error` into the same
 * application log file as the main process, so nothing is lost.
 */
export function installRendererLogging(): void {
  window.addEventListener('error', (event) => {
    const error: unknown = event.error;
    report(
      'error',
      event.message || 'Renderer error',
      error instanceof Error ? error.stack : undefined,
      'window.onerror',
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    report(
      'error',
      toText(reason),
      reason instanceof Error ? reason.stack : undefined,
      'unhandledrejection',
    );
  });

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    report('error', args.map(toText).join(' '), undefined, 'console.error');
    originalError(...args);
  };

  report('info', 'Renderer started', undefined, 'renderer');
}
