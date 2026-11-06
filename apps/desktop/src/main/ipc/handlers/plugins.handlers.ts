import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register Plugin Marketplace and Updates IPC handlers. */
export function registerPluginHandlers(): void {
  registerHandler('plugins:list', async () => orThrow(await getContainer().pluginService.list()));

  registerHandler('plugins:active', async () =>
    orThrow(await getContainer().pluginService.active()),
  );

  registerHandler('plugins:install', async ({ id }) => {
    orThrow(await getContainer().pluginService.install(id));
    audit('plugin.installed', `Installed the extension ${id}`);
  });

  registerHandler('plugins:setEnabled', async ({ id, enabled }) => {
    orThrow(await getContainer().pluginService.setEnabled(id, enabled));
    audit(
      enabled ? 'plugin.enabled' : 'plugin.disabled',
      `${enabled ? 'Enabled' : 'Disabled'} the extension ${id}`,
    );
  });

  registerHandler('plugins:uninstall', async ({ id }) => {
    orThrow(await getContainer().pluginService.uninstall(id));
    audit('plugin.uninstalled', `Uninstalled the extension ${id}`);
  });
}

function audit(type: string, message: string): void {
  getContainer().activityService.recordSafe({ type, message });
}
