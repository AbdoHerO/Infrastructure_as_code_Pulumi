import type { DeploymentTarget } from '@cloudforge/core';
import type { SshTargetRequest } from '@shared/ipc/contract.js';
import { getContainer } from '../../container.js';
import { orThrow } from '../result.js';

/** Resolve encrypted SSH credentials in the main process so secrets never cross IPC. */
export async function resolveSshTarget(request: SshTargetRequest): Promise<DeploymentTarget> {
  const authentication = orThrow(
    await getContainer().sshKeyService.resolveAuthentication(request.sshCredentialId),
  );
  return {
    host: request.host,
    port: request.port,
    username: request.username,
    ...authentication,
    hostKeySha256: request.hostKeySha256,
  };
}
