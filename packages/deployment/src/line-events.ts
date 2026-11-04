import type { SshEvent } from './ssh-transport.js';

type LineEventSink = (event: {
  readonly stream: 'step' | 'stdout' | 'stderr' | 'error';
  readonly message: string;
}) => void;

/**
 * Turn output chunks into whole lines for the log, dropping the `@@` status
 * lines meant for the parser. `==>` lines become steps.
 */
export function lineEvents(onEvent?: LineEventSink): {
  push: (event: SshEvent) => void;
  flush: () => void;
} {
  const pending = { stdout: '', stderr: '' };
  const emit = (stream: 'stdout' | 'stderr', line: string): void => {
    const text = line.replace(/\r$/, '');
    if (!onEvent || text.trim() === '' || text.startsWith('@@')) return;
    if (stream === 'stdout' && text.startsWith('==> '))
      onEvent({ stream: 'step', message: text.slice(4) });
    else onEvent({ stream, message: text });
  };
  return {
    push(event) {
      if (event.stream !== 'stdout' && event.stream !== 'stderr') {
        onEvent?.(event);
        return;
      }
      const lines = (pending[event.stream] + event.message).split('\n');
      pending[event.stream] = lines.pop() ?? '';
      for (const line of lines) emit(event.stream, line);
    },
    flush() {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (pending[stream]) emit(stream, pending[stream]);
        pending[stream] = '';
      }
    },
  };
}
