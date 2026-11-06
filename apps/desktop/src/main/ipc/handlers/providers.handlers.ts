import {
  FIREWALL_RULE_PRESETS,
  firewallAllowsPublicPort,
  firewallWarnings,
} from '@cloudforge/core';
import { UnauthorizedError } from '@cloudforge/shared';
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

  registerHandler('providers:listImages', async ({ credentialId }) =>
    orThrow(await getContainer().providerService.listImages(credentialId)),
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

  registerHandler('providers:instanceAction', async ({ credentialId, instanceId, action }) => {
    const container = getContainer();
    const instance = orThrow(
      await container.providerService.instanceAction(credentialId, instanceId, action),
    );
    container.activityService.recordSafe({
      type: `provider.instance_${action}`,
      message: `Ran ${action} on the cloud instance ${instance.name}`,
      metadata: { instanceId },
    });
    return instance;
  });

  registerHandler('providers:terminateInstance', async (request) => {
    const { credentialId, instanceId, confirmationName } = request;
    const container = getContainer();
    if (confirmationName !== undefined) {
      const instances = orThrow(await container.providerService.listInstances(credentialId));
      const instance = instances.find((item) => item.id === instanceId);
      if (instance?.name !== confirmationName) {
        throw new UnauthorizedError('Type the exact instance name to confirm termination');
      }
    }
    orThrow(await container.providerService.terminateInstance(credentialId, instanceId));
    container.activityService.recordSafe({
      type: 'provider.instance_terminated',
      message: `Terminated cloud instance ${instanceId}`,
    });
  });
  registerHandler('firewall:get', async ({ credentialId, instanceId }) =>
    orThrow(await getContainer().providerService.getInstanceFirewall(credentialId, instanceId)),
  );
  registerHandler('firewall:update', async ({ credentialId, instanceId, expectedRules, rules }) => {
    const container = getContainer();
    const previous = orThrow(
      await container.providerService.getInstanceFirewall(credentialId, instanceId),
    );
    if (JSON.stringify(previous.rules) !== JSON.stringify(expectedRules))
      throw new Error(
        'The cloud firewall changed since it was loaded. Refresh and review before applying.',
      );
    const updated = orThrow(
      await container.providerService.updateInstanceFirewall(credentialId, instanceId, rules),
    );
    container.activityService.recordSafe({
      type: 'firewall.rules.updated',
      message: `Updated firewall rules for ${updated.instanceName}`,
      metadata: {
        instanceId,
        securityListId: updated.securityListId,
        before: previous.rules,
        after: updated.rules,
        actor: 'local-user',
      },
    });
    return updated;
  });
  registerHandler('firewall:analyze', ({ rules, ports }) => ({
    warnings: firewallWarnings(rules),
    presets: FIREWALL_RULE_PRESETS,
    publicPorts: (ports ?? []).map((port) => ({
      port,
      allowed: firewallAllowsPublicPort(rules, port),
    })),
  }));
  registerHandler('firewall:history', async ({ instanceId, limit }) => {
    const events = orThrow(
      await getContainer().activityService.list(1000, { typePrefix: 'firewall.rules.updated' }),
    );
    return events.filter((event) => event.metadata.instanceId === instanceId).slice(0, limit ?? 50);
  });
}
