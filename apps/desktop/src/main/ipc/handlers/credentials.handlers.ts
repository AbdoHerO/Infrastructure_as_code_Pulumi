import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { dialog } from 'electron';
import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

const MAX_ENVIRONMENT_FILE_BYTES = 1024 * 1024;

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

  registerHandler('credentials:importEnvironmentFile', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Select a deployment environment file',
      properties: ['openFile'],
      filters: [
        {
          name: 'Environment files',
          extensions: ['env', 'production', 'staging', 'development', 'local'],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('Select a regular environment file');
    if (metadata.size === 0) throw new Error('The selected environment file is empty');
    if (metadata.size > MAX_ENVIRONMENT_FILE_BYTES)
      throw new Error('Environment files must be 1 MB or smaller');
    const content = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
    if (content.includes('\0')) throw new Error('The selected file is not a valid text file');
    return { filename: basename(path), content };
  });

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
