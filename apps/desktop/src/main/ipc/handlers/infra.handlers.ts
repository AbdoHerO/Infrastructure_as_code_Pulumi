import type { EngineEvent, StackReference } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { projectStackReference } from '../../infra/stack-reference.js';

/** Derive a stable Pulumi stack reference from a project. */
async function stackRef(projectId: string): Promise<StackReference> {
  const project = orThrow(await getContainer().projectService.get(projectId));
  return projectStackReference(project);
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

  registerHandler('infra:apply', async ({ projectId, streamId, previewToken }) => {
    const ref = await stackRef(projectId);
    const result = orThrow(
      await getContainer().infrastructureService.apply(
        ref,
        projectId,
        previewToken,
        sink(streamId),
      ),
    );
    getContainer().activityService.recordSafe({
      type: 'infrastructure.applied',
      message: 'Applied infrastructure plan',
      projectId,
    });
    return result;
  });

  registerHandler('infra:destroy', async ({ projectId, streamId }) => {
    const ref = await stackRef(projectId);
    orThrow(await getContainer().infrastructureService.destroy(ref, projectId, sink(streamId)));
    getContainer().activityService.recordSafe({
      type: 'infrastructure.destroyed',
      message: 'Destroyed infrastructure and removed its saved plan',
      projectId,
    });
  });

  registerHandler('infra:refresh', async ({ projectId, streamId }) => {
    const ref = await stackRef(projectId);
    orThrow(await getContainer().infrastructureService.refresh(ref, sink(streamId)));
    getContainer().activityService.recordSafe({
      type: 'infrastructure.refreshed',
      message: 'Refreshed infrastructure state and detected drift',
      projectId,
    });
  });

  registerHandler('infra:outputs', async ({ projectId }) => {
    const ref = await stackRef(projectId);
    return orThrow(await getContainer().infrastructureService.outputs(ref));
  });

  registerHandler('infra:managedStacks', async () =>
    orThrow(await getContainer().infrastructureService.listManagedStacks()),
  );

  registerHandler('infra:destroyStack', async ({ ref, streamId }) => {
    orThrow(await getContainer().infrastructureService.destroyManagedStack(ref, sink(streamId)));
    getContainer().activityService.recordSafe({
      type: 'infrastructure.destroyed',
      message: `Destroyed managed stack ${ref.project}/${ref.stack}`,
    });
  });

  registerHandler('infra:templates', () => getContainer().infrastructureService.listTemplates());

  registerHandler('infra:applyTemplate', async ({ projectId, templateId, sshPublicKey, region }) =>
    orThrow(
      await getContainer().infrastructureService.applyTemplate(projectId, templateId, {
        ...(sshPublicKey ? { sshPublicKey } : {}),
        ...(region ? { region } : {}),
      }),
    ),
  );

  registerHandler('infra:customTemplates', async () =>
    orThrow(await getContainer().infrastructureService.listCustomTemplates()),
  );

  registerHandler('infra:saveTemplate', async ({ name, description, plan }) =>
    orThrow(
      await getContainer().infrastructureService.saveCustomTemplate({
        name,
        plan,
        ...(description ? { description } : {}),
      }),
    ),
  );

  registerHandler('infra:deleteTemplate', async ({ id }) =>
    orThrow(await getContainer().infrastructureService.deleteCustomTemplate(id)),
  );

  registerHandler('infra:applyCustomTemplate', async ({ projectId, templateId }) =>
    orThrow(await getContainer().infrastructureService.applyCustomTemplate(projectId, templateId)),
  );
}
