import { registerAppHandlers } from './handlers/app.handlers.js';
import { registerProjectHandlers } from './handlers/projects.handlers.js';
import { registerCredentialHandlers } from './handlers/credentials.handlers.js';
import { registerSettingsHandlers } from './handlers/settings.handlers.js';
import { registerProviderHandlers } from './handlers/providers.handlers.js';
import { registerInfraHandlers } from './handlers/infra.handlers.js';
import { registerDeployHandlers } from './handlers/deploy.handlers.js';
import { registerActivityHandlers } from './handlers/activity.handlers.js';
import { registerPluginHandlers } from './handlers/plugins.handlers.js';
import { registerLogHandlers } from './handlers/logs.handlers.js';
import { registerSshKeyHandlers } from './handlers/ssh-keys.handlers.js';
import { registerContainerHandlers } from './handlers/containers.handlers.js';
import { registerBackupHandlers } from './handlers/backup.handlers.js';
import { registerUpdateHandlers } from './handlers/updates.handlers.js';
import { registerAnsibleHandlers } from './handlers/ansible.handlers.js';
import { registerNginxHandlers } from './handlers/nginx.handlers.js';
import { registerSslHandlers } from './handlers/ssl.handlers.js';

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
  registerLogHandlers();
  registerSshKeyHandlers();
  registerContainerHandlers();
  registerBackupHandlers();
  registerUpdateHandlers();
  registerAnsibleHandlers();
  registerNginxHandlers();
  registerSslHandlers();
}
