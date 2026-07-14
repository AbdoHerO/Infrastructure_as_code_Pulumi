import { chmod, writeFile } from 'node:fs/promises';
import { dialog } from 'electron';
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

  registerHandler('sshKeys:exportPrivate', async ({ id, suggestedName }) => {
    const selected = await dialog.showSaveDialog({
      title: 'Export SSH private key',
      defaultPath: suggestedName.replace(/[^a-zA-Z0-9._-]/g, '-'),
      filters: [{ name: 'SSH private key', extensions: ['pem', 'key', '*'] }],
    });
    if (selected.canceled || !selected.filePath) return { path: null };
    const privateKey = orThrow(await getContainer().sshKeyService.revealPrivate(id));
    await writeFile(selected.filePath, privateKey, { encoding: 'utf8', mode: 0o600 });
    await chmod(selected.filePath, 0o600).catch(() => undefined);
    return { path: selected.filePath };
  });

  registerHandler('sshKeys:delete', async ({ id }) =>
    orThrow(await getContainer().sshKeyService.remove(id)),
  );
}
