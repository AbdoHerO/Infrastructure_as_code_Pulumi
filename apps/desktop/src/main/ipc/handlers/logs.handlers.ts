import { shell } from 'electron';
import { getContainer } from '../../container.js';
import { getLogDir, getLogFilePath, log, pruneLogs, readLastLines } from '../../logging/logger.js';
import { registerHandler } from '../registry.js';

/** Register the application-log IPC handlers. */
export function registerLogHandlers(): void {
  registerHandler('logs:info', () => ({ path: getLogFilePath(), dir: getLogDir() }));

  registerHandler('logs:tail', ({ lines }) => readLastLines(lines ?? 300));

  registerHandler('logs:prune', async () => {
    const settings = await getContainer().settingsService.get();
    if (!settings.ok) throw settings.error;
    return { removed: pruneLogs(settings.value.logs.retentionDays) };
  });

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
