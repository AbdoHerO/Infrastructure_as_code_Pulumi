import type { DeploymentTarget } from '@cloudforge/core';
import { UnauthorizedError } from '@cloudforge/shared';
import type { SshTargetRequest } from '@shared/ipc/contract.js';
import { getContainer } from '../../container.js';
import { orThrow } from '../result.js';
import { hostKeyTrust } from '../../security/host-key-trust.js';

/**
 * Refuse a fingerprint the main process has never seen for this host. A saved target
 * pins one; a server being added has just been inspected here.
 */
export async function requireKnownHostKey(request: {
  readonly host: string;
  readonly port: number;
  readonly hostKeySha256: string;
}): Promise<void> {
  const { host, port, hostKeySha256 } = request;
  if (hostKeyTrust.wasInspected(host, port, hostKeySha256)) return;
  const saved = orThrow(await getContainer().vpsTargetService.list());
  const pinned = saved.some(
    (target) =>
      target.host === host && target.port === port && target.hostKeySha256 === hostKeySha256,
  );
  if (!pinned) {
    throw new UnauthorizedError(
      `Inspect ${host} again: this fingerprint was not read from that server.`,
    );
  }
}

/** Resolve encrypted SSH credentials in the main process so secrets never cross IPC. */
export async function resolveSshTarget(request: SshTargetRequest): Promise<DeploymentTarget> {
  await requireKnownHostKey(request);
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
