import { hostAccessInstructions, hostAccessKeyRequest } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/**
 * SSH access for other people on a saved target.
 *
 * Payloads carry the target id, the account name and the person's PUBLIC key:
 * the host, its pinned key and CloudForge's own credential are loaded in the
 * main process and never cross to the renderer.
 */
export function registerHostAccessHandlers(): void {
  const service = (): ReturnType<typeof getContainer>['hostAccessService'] =>
    getContainer().hostAccessService;

  registerHandler('hostAccess:inspect', async ({ targetId }) =>
    orThrow(await service().inspect(targetId)),
  );
  registerHandler('hostAccess:instructions', async ({ targetId, username, sudo, language }) => {
    const target = orThrow(await getContainer().vpsTargetService.get(targetId));
    const chosen = language ?? 'en';
    return {
      ...hostAccessInstructions(target, username, { sudo: sudo ?? false, language: chosen }),
      keyRequest: hostAccessKeyRequest(chosen),
    };
  });
  registerHandler('hostAccess:grant', async ({ targetId, username, publicKey, sudo }) =>
    orThrow(await service().grant(targetId, { username, publicKey, sudo })),
  );
  registerHandler('hostAccess:revoke', async ({ targetId, username }) =>
    orThrow(await service().revoke(targetId, username)),
  );
}
