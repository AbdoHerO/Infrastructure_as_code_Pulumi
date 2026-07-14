import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog } from 'electron';
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

  registerHandler('sshKeys:materializePrivate', async ({ id, suggestedName }) => {
    const directory = join(app.getPath('home'), '.ssh');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const safeName = suggestedName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    const filePath = join(directory, `cloudforge-${safeName || 'key'}-${id.slice(0, 8)}`);
    const privateKey = orThrow(await getContainer().sshKeyService.revealPrivate(id));
    await writeFile(filePath, privateKey, { encoding: 'utf8', mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return { path: filePath };
  });

  registerHandler('sshKeys:delete', async ({ id }) =>
    orThrow(await getContainer().sshKeyService.remove(id)),
  );
}
