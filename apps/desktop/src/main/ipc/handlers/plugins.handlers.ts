import { app } from 'electron';
import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register Plugin Marketplace and Updates IPC handlers. */
export function registerPluginHandlers(): void {
  registerHandler('plugins:list', async () => orThrow(await getContainer().pluginService.list()));

  registerHandler('plugins:install', async ({ id }) =>
    orThrow(await getContainer().pluginService.install(id)),
  );

  registerHandler('plugins:setEnabled', async ({ id, enabled }) =>
    orThrow(await getContainer().pluginService.setEnabled(id, enabled)),
  );

  registerHandler('plugins:uninstall', async ({ id }) =>
    orThrow(await getContainer().pluginService.uninstall(id)),
  );

  registerHandler('updates:check', () => {
    // Full auto-update wiring (electron-updater) is enabled at packaging time.
    const current = app.getVersion();
    return { current, latest: current, upToDate: true };
  });
}
