import type { EngineEvent, StackReference } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Derive a stable Pulumi stack reference from a project. */
async function stackRef(projectId: string): Promise<StackReference> {
  const project = orThrow(await getContainer().projectService.get(projectId));
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return { project: `${slug || 'project'}-${projectId.slice(0, 8)}`, stack: project.environment };
}

/** Forward engine output to the renderer as `engine:log` events. */
function sink(streamId: string): (event: EngineEvent) => void {
  return (event) => emitEvent('engine:log', { streamId, event });
}

/** Register the Infrastructure module IPC handlers. */
export function registerInfraHandlers(): void {
  registerHandler('infra:engineStatus', async () => {
    const available = orThrow(await getContainer().infrastructureService.isEngineAvailable());
    return { available };
  });

  registerHandler('infra:getPlan', async ({ projectId }) =>
    orThrow(await getContainer().infrastructureService.getPlan(projectId)),
  );

  registerHandler('infra:savePlan', async ({ projectId, plan }) =>
    orThrow(await getContainer().infrastructureService.savePlan(projectId, plan)),
  );

  registerHandler('infra:validate', ({ plan }) =>
    getContainer().infrastructureService.validate(plan),
  );

  registerHandler('infra:preview', async ({ projectId, streamId }) => {
    const ref = await stackRef(projectId);
    return orThrow(
      await getContainer().infrastructureService.preview(ref, projectId, sink(streamId)),
    );
  });

  registerHandler('infra:apply', async ({ projectId, streamId }) => {
    const ref = await stackRef(projectId);
    return orThrow(
      await getContainer().infrastructureService.apply(ref, projectId, sink(streamId)),
    );
  });

  registerHandler('infra:destroy', async ({ projectId, streamId }) => {
    const ref = await stackRef(projectId);
    return orThrow(await getContainer().infrastructureService.destroy(ref, sink(streamId)));
  });

  registerHandler('infra:outputs', async ({ projectId }) => {
    const ref = await stackRef(projectId);
    return orThrow(await getContainer().infrastructureService.outputs(ref));
  });
}
