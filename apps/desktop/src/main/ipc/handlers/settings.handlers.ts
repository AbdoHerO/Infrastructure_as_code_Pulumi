import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { pruneLogs } from '../../logging/logger.js';

/** Register the Settings IPC handlers. */
export function registerSettingsHandlers(): void {
  registerHandler('settings:get', async () => orThrow(await getContainer().settingsService.get()));

  registerHandler('settings:update', async (patch) => {
    const settings = orThrow(await getContainer().settingsService.update(patch));
    pruneLogs(settings.logs.retentionDays);
    return settings;
  });
}
