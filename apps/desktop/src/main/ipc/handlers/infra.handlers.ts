import type { EngineEvent, StackReference } from '@cloudforge/core';
import { UnauthorizedError } from '@cloudforge/shared';
import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { projectStackReference } from '../../infra/stack-reference.js';
import { projectOperations } from '../../project-operation-registry.js';

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
    return providerOperation('preview', projectId, streamId, async () =>
      orThrow(await getContainer().infrastructureService.preview(ref, projectId, sink(streamId))),
    );
  });

  registerHandler('infra:apply', async ({ projectId, streamId, previewToken }) => {
    const ref = await stackRef(projectId);
    const result = await providerOperation('apply', projectId, streamId, async () =>
      orThrow(
        await getContainer().infrastructureService.apply(
          ref,
          projectId,
          previewToken,
          sink(streamId),
        ),
      ),
    );
    getContainer().activityService.recordSafe({
      type: 'infrastructure.applied',
      message: 'Applied infrastructure plan',
      projectId,
    });
    if (result.targetSync?.count) emitEvent('vpsTargets:changed', { reason: 'synchronized' });
    return result;
  });

  registerHandler('infra:destroy', async ({ projectId, streamId }) => {
    const ref = await stackRef(projectId);
    await providerOperation('destroy', projectId, streamId, async () =>
      orThrow(await getContainer().infrastructureService.destroy(ref, projectId, sink(streamId))),
    );
    getContainer().activityService.recordSafe({
      type: 'infrastructure.destroyed',
      message: 'Destroyed infrastructure and removed its saved plan',
      projectId,
    });
    emitEvent('vpsTargets:changed', { reason: 'deleted' });
  });

  registerHandler('infra:refresh', async ({ projectId, streamId }) => {
    const ref = await stackRef(projectId);
    await providerOperation('refresh', projectId, streamId, async () =>
      orThrow(await getContainer().infrastructureService.refresh(ref, sink(streamId))),
    );
    getContainer().activityService.recordSafe({
      type: 'infrastructure.refreshed',
      message: 'Refreshed infrastructure state and detected drift',
      projectId,
    });
  });

  registerHandler('infra:outputs', async ({ projectId }) => {
    const ref = await stackRef(projectId);
    const outputs = orThrow(await getContainer().infrastructureService.outputs(ref, projectId));
    emitEvent('vpsTargets:changed', { reason: 'synchronized' });
    return outputs;
  });

  registerHandler('infra:managedStacks', async () => {
    const active = getContainer().projectContext.requireActive();
    const project = orThrow(await getContainer().projectService.get(active.projectId));
    const expected = projectStackReference(project);
    const stacks = orThrow(await getContainer().infrastructureService.listManagedStacks());
    return stacks.filter(
      ({ ref }) => ref.project === expected.project && ref.stack === expected.stack,
    );
  });

  registerHandler('infra:destroyStack', async ({ ref, streamId }) => {
    const active = getContainer().projectContext.requireActive();
    const owner = orThrow(await getContainer().projectService.get(active.projectId));
    const expected = projectStackReference(owner);
    if (expected.project !== ref.project || expected.stack !== ref.stack) {
      throw new UnauthorizedError('The managed stack belongs to another project');
    }
    await providerOperation('destroy-stack', owner.id, streamId, async () =>
      orThrow(await getContainer().infrastructureService.destroyManagedStack(ref, sink(streamId))),
    );
    orThrow(await getContainer().vpsTargetService.removeManagedProject(owner.id));
    emitEvent('vpsTargets:changed', { reason: 'deleted' });
    getContainer().activityService.recordSafe({
      type: 'infrastructure.destroyed',
      message: `Destroyed managed stack ${ref.project}/${ref.stack}`,
    });
  });

  registerHandler('infra:templates', () => getContainer().infrastructureService.listTemplates());

  registerHandler(
    'infra:applyTemplate',
    async ({ projectId, templateId, sshPublicKey, sshCredentialId, region }) =>
      orThrow(
        await getContainer().infrastructureService.applyTemplate(projectId, templateId, {
          ...(sshPublicKey ? { sshPublicKey } : {}),
          ...(sshCredentialId ? { sshCredentialId } : {}),
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

async function providerOperation<T>(
  name: string,
  projectId: string,
  streamId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = projectOperations.begin(`infra:${name}:${streamId}`, projectId, false);
  try {
    return await operation();
  } finally {
    lease.complete();
  }
}
