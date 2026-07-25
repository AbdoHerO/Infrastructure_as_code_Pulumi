import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { pruneLogs } from '../../logging/logger.js';
import { configureUpdateManager } from '../../updates/update-manager.js';

/** Register the Settings IPC handlers. */
export function registerSettingsHandlers(): void {
  registerHandler('settings:get', async () => orThrow(await getContainer().settingsService.get()));

  registerHandler('settings:update', async (patch) => {
    const current = getContainer();
    const settings = orThrow(await current.settingsService.update(patch));
    orThrow(
      await current.systemSettingsService.update({
        appearance: settings.appearance,
        logs: settings.logs,
        updates: settings.updates,
      }),
    );
    pruneLogs(settings.logs.retentionDays);
    configureUpdateManager(settings.updates.autoDownload);
    return settings;
  });
}
