import type { DeploymentTarget } from '@cloudforge/core';
import type { SshTargetRequest } from '@shared/ipc/contract.js';
import { getContainer } from '../../container.js';
import { orThrow } from '../result.js';

/** Resolve encrypted SSH credentials in the main process so secrets never cross IPC. */
export async function resolveSshTarget(request: SshTargetRequest): Promise<DeploymentTarget> {
  const revealed = orThrow(await getContainer().credentialService.reveal(request.sshCredentialId));
  if (revealed.kind !== 'ssh' && revealed.kind !== 'ssh-password') {
    throw new Error('The selected credential is not an SSH credential');
  }
  const privateKey = revealed.data.privateKey;
  const password = revealed.data.password;
  if (!privateKey && !password) throw new Error('The selected SSH credential is empty');
  return {
    host: request.host,
    port: request.port,
    username: request.username,
    ...(privateKey ? { privateKey } : {}),
    ...(revealed.data.passphrase ? { passphrase: revealed.data.passphrase } : {}),
    ...(password ? { password } : {}),
    hostKeySha256: request.hostKeySha256,
  };
}
