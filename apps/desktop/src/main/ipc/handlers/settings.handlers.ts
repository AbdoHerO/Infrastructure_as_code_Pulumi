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
        deployment: { defaultRegion: settings.deployment.defaultRegion },
      }),
    );
    pruneLogs(settings.logs.retentionDays);
    configureUpdateManager(settings.updates.autoDownload);
    current.activityService.recordSafe({
      type: 'settings.updated',
      message: `Changed settings: ${Object.keys(patch).join(', ')}`,
      metadata: { sections: Object.keys(patch) },
    });
    return settings;
  });

  registerHandler('settings:newProjectDefaults', async () => {
    const settings = orThrow(await getContainer().systemSettingsService.get());
    return { region: settings.deployment.defaultRegion };
  });
}
