import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dialog } from 'electron';
import type { StackEvent } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];
const MAX_FILE_BYTES = 1_000_000;

async function readTextFile(path: string): Promise<string | null> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) return null;
  if (metadata.size > MAX_FILE_BYTES) throw new Error(`${basename(path)} must be 1 MB or smaller`);
  const content = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  if (content.includes('\0')) throw new Error(`${basename(path)} is not a text file`);
  return content;
}

/**
 * Docker stacks on saved targets. Progress lines go to `stacks:log`, matched by
 * the renderer's `streamId`. The Compose file and `.env` cross to the renderer
 * only when the user chooses a folder or asks to edit a stack.
 */
export function registerStackHandlers(): void {
  const service = (): ReturnType<typeof getContainer>['stackService'] =>
    getContainer().stackService;
  const sink =
    (streamId: string) =>
    (event: StackEvent): void =>
      emitEvent('stacks:log', { streamId, event });

  registerHandler('domains:check', async (query) =>
    orThrow(await getContainer().domainPublisher.check(query)),
  );
  registerHandler('stacks:list', async () => orThrow(await service().list()));
  registerHandler('stacks:analyze', ({ composeYaml, environment }) =>
    Promise.resolve(service().analyze(composeYaml, environment)),
  );
  registerHandler('stacks:chooseFolder', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Select the folder of your Docker stack',
      properties: ['openDirectory'],
    });
    const folder = selection.filePaths[0];
    if (selection.canceled || !folder) return null;
    for (const fileName of COMPOSE_FILE_NAMES) {
      const composeYaml = await readTextFile(join(folder, fileName));
      if (composeYaml === null) continue;
      const environment = await readTextFile(join(folder, '.env'));
      return {
        folderName: basename(folder),
        composeFileName: fileName,
        composeYaml,
        environment: environment ?? '',
        hasEnvironment: environment !== null,
      };
    }
    throw new Error(`No compose.yaml or docker-compose.yml in ${basename(folder)}`);
  });
  registerHandler('stacks:create', async ({ stack, streamId }) =>
    orThrow(await service().create(stack, sink(streamId))),
  );
  registerHandler('stacks:reveal', async ({ id }) => orThrow(await service().reveal(id)));
  registerHandler('stacks:update', async ({ id, composeYaml, environment, streamId }) =>
    orThrow(await service().update(id, { composeYaml, environment }, sink(streamId))),
  );
  registerHandler('stacks:redeploy', async ({ id, streamId }) =>
    orThrow(await service().redeploy(id, sink(streamId))),
  );
  registerHandler('stacks:status', async ({ id }) => orThrow(await service().status(id)));
  registerHandler('stacks:remove', async ({ id, deleteData, streamId }) =>
    orThrow(await service().remove(id, deleteData, sink(streamId))),
  );
}
