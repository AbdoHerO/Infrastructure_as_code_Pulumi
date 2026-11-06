import { rm, writeFile } from 'node:fs/promises';
import { dialog } from 'electron';
import { getContainer } from '../../container.js';
import {
  materializeProjectSshKey,
  removeMaterializedCredential,
} from '../../security/project-key-files.js';
import { enforceOwnerOnlyPath } from '../../security/owner-only-file.js';
import { requireLocalPath } from '../../security/local-paths.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerSshKeyHandlers(): void {
  registerHandler('sshKeys:list', async () => orThrow(await getContainer().sshKeyService.list()));

  registerHandler('sshKeys:generate', async ({ name, algorithm, passphrase }) => {
    const key = orThrow(await getContainer().sshKeyService.generate(name, algorithm, passphrase));
    audit('ssh_key.generated', `Generated the SSH key "${key.name}"`, key.id);
    return key;
  });

  registerHandler('sshKeys:import', async ({ name, privateKey, passphrase }) => {
    const key = orThrow(await getContainer().sshKeyService.import(name, privateKey, passphrase));
    audit('ssh_key.imported', `Imported the SSH key "${key.name}"`, key.id);
    return key;
  });

  registerHandler('sshKeys:revealPrivate', async ({ id }) => {
    const privateKey = orThrow(await getContainer().sshKeyService.revealPrivate(id));
    audit('ssh_key.revealed', 'Decrypted a private SSH key', id);
    return { privateKey };
  });

  registerHandler('sshKeys:exportPrivate', async ({ id, suggestedName, path }) => {
    // A path nobody chose in a dialog must not replace whatever is already there.
    const given = path === undefined ? undefined : requireLocalPath(path);
    let filePath = given;
    if (!filePath) {
      const selected = await dialog.showSaveDialog({
        title: 'Export SSH private key',
        defaultPath: suggestedName.replace(/[^a-zA-Z0-9._-]/g, '-'),
        filters: [{ name: 'SSH private key', extensions: ['pem', 'key', '*'] }],
      });
      if (selected.canceled || !selected.filePath) return { path: null };
      filePath = selected.filePath;
    }
    const privateKey = orThrow(await getContainer().sshKeyService.revealPrivate(id));
    await writeFile(filePath, privateKey, {
      encoding: 'utf8',
      mode: 0o600,
      ...(given ? { flag: 'wx' } : {}),
    });
    try {
      await enforceOwnerOnlyPath(filePath, 0o600);
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
    audit('ssh_key.exported', 'Exported a private SSH key to a file', id);
    return { path: filePath };
  });

  registerHandler('sshKeys:materializePrivate', async ({ id, suggestedName }) => {
    const projectId = getContainer().projectContext.requireActive().projectId;
    const privateKey = orThrow(await getContainer().sshKeyService.revealPrivate(id));
    audit('ssh_key.materialized', 'Wrote a private SSH key to the temporary key folder', id);
    return {
      path: await materializeProjectSshKey({
        projectId,
        credentialId: id,
        suggestedName,
        privateKey,
      }),
    };
  });

  registerHandler('sshKeys:delete', async ({ id }) => {
    const projectId = getContainer().projectContext.requireActive().projectId;
    orThrow(await getContainer().sshKeyService.remove(id));
    await removeMaterializedCredential(projectId, id);
    audit('ssh_key.deleted', 'Deleted an SSH key', id);
  });
}

function audit(type: string, message: string, credentialId: string): void {
  getContainer().activityService.recordSafe({ type, message, metadata: { credentialId } });
}
