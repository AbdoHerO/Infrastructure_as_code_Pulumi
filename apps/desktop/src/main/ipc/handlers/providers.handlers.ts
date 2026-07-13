import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register cloud-provider connection/discovery IPC handlers. */
export function registerProviderHandlers(): void {
  registerHandler('providers:test', async ({ credentialId }) =>
    orThrow(await getContainer().providerService.testConnection(credentialId)),
  );

  registerHandler('providers:listRegions', async ({ credentialId }) =>
    orThrow(await getContainer().providerService.listRegions(credentialId)),
  );

  registerHandler('providers:listShapes', async ({ credentialId }) =>
    orThrow(await getContainer().providerService.listShapes(credentialId)),
  );

  registerHandler('providers:listAvailabilityDomains', async ({ credentialId }) =>
    orThrow(await getContainer().providerService.listAvailabilityDomains(credentialId)),
  );
}
