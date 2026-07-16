import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/**
 * Containers and the read-only runtime inventory.
 *
 * Every handler goes through `ContainerService`, which resolves the saved
 * target's pinned host key itself. Payloads therefore carry a target id and
 * never a host or fingerprint chosen by the renderer.
 */
export function registerContainerHandlers(): void {
  const service = (): ReturnType<typeof getContainer>['containerService'] =>
    getContainer().containerService;

  registerHandler('containers:list', async ({ targetId }) =>
    orThrow(await service().list(targetId)),
  );
  registerHandler('containers:action', async ({ targetId, containerId, action }) =>
    orThrow(await service().action(targetId, containerId, action)),
  );
  registerHandler('containers:logs', async ({ targetId, containerId, lines }) => ({
    text: orThrow(await service().logs(targetId, containerId, lines ?? 200)),
  }));
  registerHandler('containers:stats', async ({ targetId, containerId }) =>
    orThrow(await service().stats(targetId, containerId)),
  );
  registerHandler('containers:deployCompose', async ({ targetId, projectName, composeYaml }) =>
    orThrow(await service().deployCompose(targetId, projectName, composeYaml)),
  );

  registerHandler('runtime:inspect', async ({ targetId }) =>
    orThrow(await service().inspect(targetId)),
  );
}
