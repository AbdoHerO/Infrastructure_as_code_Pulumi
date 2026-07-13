import { shell } from 'electron';
import { getLogDir, getLogFilePath, log, readLastLines } from '../../logging/logger.js';
import { registerHandler } from '../registry.js';

/** Register the application-log IPC handlers. */
export function registerLogHandlers(): void {
  registerHandler('logs:info', () => ({ path: getLogFilePath(), dir: getLogDir() }));

  registerHandler('logs:tail', ({ lines }) => readLastLines(lines ?? 300));

  registerHandler('logs:openFolder', async () => {
    await shell.openPath(getLogDir());
  });

  // Renderer-side errors/warnings are forwarded here so they land in the same
  // log file as everything else.
  registerHandler('logs:report', ({ level, message, stack, source }) => {
    log()[level](
      { event: 'renderer', source: source ?? 'renderer', ...(stack ? { stack } : {}) },
      message,
    );
  });
}
