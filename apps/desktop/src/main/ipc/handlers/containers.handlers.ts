import type { DeploymentTarget } from '@cloudforge/core';
import type { ContainerTargetRequest } from '@shared/ipc/contract.js';
import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerContainerHandlers(): void {
  registerHandler('containers:list', async (request) =>
    orThrow(await getContainer().containerManager.list(await target(request))),
  );
  registerHandler('containers:action', async ({ containerId, action, ...request }) =>
    orThrow(
      await getContainer().containerManager.action(await target(request), containerId, action),
    ),
  );
  registerHandler('containers:logs', async ({ containerId, lines, ...request }) => ({
    text: orThrow(
      await getContainer().containerManager.logs(await target(request), containerId, lines ?? 200),
    ),
  }));
  registerHandler('containers:stats', async ({ containerId, ...request }) =>
    orThrow(await getContainer().containerManager.stats(await target(request), containerId)),
  );
  registerHandler('containers:deployCompose', async ({ projectName, composeYaml, ...request }) =>
    orThrow(
      await getContainer().containerManager.deployCompose(
        await target(request),
        projectName,
        composeYaml,
      ),
    ),
  );
}

async function target(request: ContainerTargetRequest): Promise<DeploymentTarget> {
  const revealed = orThrow(await getContainer().credentialService.reveal(request.sshCredentialId));
  return {
    host: request.host,
    port: request.port,
    username: request.username,
    privateKey: revealed.data.privateKey ?? '',
    passphrase: revealed.data.passphrase,
    hostKeySha256: request.hostKeySha256,
  };
}
