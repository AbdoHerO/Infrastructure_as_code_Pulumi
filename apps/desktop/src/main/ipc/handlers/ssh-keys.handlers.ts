import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerSshKeyHandlers(): void {
  registerHandler('sshKeys:list', async () => orThrow(await getContainer().sshKeyService.list()));

  registerHandler('sshKeys:generate', async ({ name, algorithm, passphrase }) =>
    orThrow(await getContainer().sshKeyService.generate(name, algorithm, passphrase)),
  );

  registerHandler('sshKeys:import', async ({ name, privateKey, passphrase }) =>
    orThrow(await getContainer().sshKeyService.import(name, privateKey, passphrase)),
  );

  registerHandler('sshKeys:revealPrivate', async ({ id }) => ({
    privateKey: orThrow(await getContainer().sshKeyService.revealPrivate(id)),
  }));

  registerHandler('sshKeys:delete', async ({ id }) =>
    orThrow(await getContainer().sshKeyService.remove(id)),
  );
}
