import { registerAppHandlers } from './handlers/app.handlers.js';
import { registerProjectHandlers } from './handlers/projects.handlers.js';
import { registerCredentialHandlers } from './handlers/credentials.handlers.js';
import { registerSettingsHandlers } from './handlers/settings.handlers.js';
import { registerProviderHandlers } from './handlers/providers.handlers.js';
import { registerInfraHandlers } from './handlers/infra.handlers.js';
import { registerDeployHandlers } from './handlers/deploy.handlers.js';
import { registerActivityHandlers } from './handlers/activity.handlers.js';
import { registerPluginHandlers } from './handlers/plugins.handlers.js';

/**
 * Register every IPC handler exactly once during app startup. Feature modules
 * add their registration function here as the application grows.
 */
export function registerIpcHandlers(): void {
  registerAppHandlers();
  registerProjectHandlers();
  registerCredentialHandlers();
  registerSettingsHandlers();
  registerProviderHandlers();
  registerInfraHandlers();
  registerDeployHandlers();
  registerActivityHandlers();
  registerPluginHandlers();
}
