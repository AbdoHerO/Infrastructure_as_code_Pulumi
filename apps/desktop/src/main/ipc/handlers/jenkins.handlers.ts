import type { JenkinsPipelineService } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerJenkinsHandlers(): void {
  const service = (): JenkinsPipelineService => getContainer().jenkinsPipelineService;
  registerHandler('jenkins:list', async () => orThrow(await service().list()));
  registerHandler('jenkins:test', async ({ targetId, credentialId }) =>
    orThrow(await service().test(targetId, credentialId)),
  );
  registerHandler('jenkins:save', async (input) => orThrow(await service().save(input)));
  registerHandler('jenkins:delete', async ({ id }) => orThrow(await service().remove(id)));
  registerHandler('jenkins:trigger', async ({ id, parameters }) =>
    orThrow(await service().trigger(id, parameters)),
  );
  registerHandler('jenkins:status', async ({ id }) => orThrow(await service().status(id)));
}
