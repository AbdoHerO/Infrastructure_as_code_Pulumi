import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register the Settings IPC handlers. */
export function registerSettingsHandlers(): void {
  registerHandler('settings:get', async () => orThrow(await getContainer().settingsService.get()));

  registerHandler('settings:update', async (patch) =>
    orThrow(await getContainer().settingsService.update(patch)),
  );
}
