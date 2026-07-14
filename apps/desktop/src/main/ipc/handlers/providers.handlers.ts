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

  registerHandler('providers:listInstances', async ({ credentialId }) =>
    orThrow(await getContainer().providerService.listInstances(credentialId)),
  );

  registerHandler('providers:listResources', async ({ credentialId }) =>
    orThrow(await getContainer().providerService.listResources(credentialId)),
  );

  registerHandler('providers:instanceAction', async ({ credentialId, instanceId, action }) =>
    orThrow(await getContainer().providerService.instanceAction(credentialId, instanceId, action)),
  );

  registerHandler('providers:terminateInstance', async ({ credentialId, instanceId }) => {
    const container = getContainer();
    orThrow(await container.providerService.terminateInstance(credentialId, instanceId));
    container.activityService.recordSafe({
      type: 'provider.instance_terminated',
      message: `Terminated cloud instance ${instanceId}`,
    });
  });
}
