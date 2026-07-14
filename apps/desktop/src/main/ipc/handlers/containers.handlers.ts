import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { resolveSshTarget } from './ssh-target.js';

export function registerContainerHandlers(): void {
  registerHandler('containers:list', async (request) =>
    orThrow(await getContainer().containerManager.list(await resolveSshTarget(request))),
  );
  registerHandler('containers:action', async ({ containerId, action, ...request }) =>
    orThrow(
      await getContainer().containerManager.action(
        await resolveSshTarget(request),
        containerId,
        action,
      ),
    ),
  );
  registerHandler('containers:logs', async ({ containerId, lines, ...request }) => ({
    text: orThrow(
      await getContainer().containerManager.logs(
        await resolveSshTarget(request),
        containerId,
        lines ?? 200,
      ),
    ),
  }));
  registerHandler('containers:stats', async ({ containerId, ...request }) =>
    orThrow(
      await getContainer().containerManager.stats(await resolveSshTarget(request), containerId),
    ),
  );
  registerHandler('containers:deployCompose', async ({ projectName, composeYaml, ...request }) =>
    orThrow(
      await getContainer().containerManager.deployCompose(
        await resolveSshTarget(request),
        projectName,
        composeYaml,
      ),
    ),
  );
}
