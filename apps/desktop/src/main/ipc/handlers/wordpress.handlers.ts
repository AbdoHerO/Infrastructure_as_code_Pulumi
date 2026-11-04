import type { WordPressEvent } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/**
 * WordPress sites on saved targets. Progress lines go to `wordpress:log`,
 * matched by the renderer's `streamId`. The admin password crosses to the
 * renderer once, in the create response, so it can be shown and copied.
 */
export function registerWordPressHandlers(): void {
  const service = (): ReturnType<typeof getContainer>['wordpressService'] =>
    getContainer().wordpressService;
  const sink =
    (streamId: string) =>
    (event: WordPressEvent): void =>
      emitEvent('wordpress:log', { streamId, event });

  registerHandler('wordpress:list', async () => orThrow(await service().list()));
  registerHandler('wordpress:checkDomain', async (query) =>
    orThrow(await service().checkDomain(query)),
  );
  registerHandler('wordpress:create', async ({ site, streamId }) =>
    orThrow(await service().create(site, sink(streamId))),
  );
  registerHandler('wordpress:redeploy', async ({ id, streamId }) =>
    orThrow(await service().redeploy(id, sink(streamId))),
  );
  registerHandler('wordpress:update', async ({ id, streamId }) =>
    orThrow(await service().update(id, sink(streamId))),
  );
  registerHandler('wordpress:status', async ({ id }) => orThrow(await service().status(id)));
  registerHandler('wordpress:remove', async ({ id, deleteData, streamId }) =>
    orThrow(await service().remove(id, deleteData, sink(streamId))),
  );
}
