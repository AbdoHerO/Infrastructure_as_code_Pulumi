import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register the Credential Manager IPC handlers. */
export function registerCredentialHandlers(): void {
  registerHandler('credentials:list', async () =>
    orThrow(await getContainer().credentialService.list()),
  );

  registerHandler('credentials:create', async (input) =>
    orThrow(await getContainer().credentialService.create(input)),
  );

  registerHandler('credentials:update', async (input) =>
    orThrow(await getContainer().credentialService.update(input)),
  );

  registerHandler('credentials:reveal', async ({ id }) =>
    orThrow(await getContainer().credentialService.reveal(id)),
  );

  registerHandler('credentials:delete', async ({ id }) =>
    orThrow(await getContainer().credentialService.remove(id)),
  );

  registerHandler('security:status', () => ({
    backedByOsKeychain: getContainer().secretsBackedByOsKeychain,
  }));
}
