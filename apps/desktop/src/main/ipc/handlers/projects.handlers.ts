import { ConflictError } from '@cloudforge/shared';
import { getContainer } from '../../container.js';
import { projectStackReference } from '../../infra/stack-reference.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { emitEvent } from '../emit.js';

/** Register the Projects module IPC handlers. */
export function registerProjectHandlers(): void {
  registerHandler('projects:list', async () => orThrow(await getContainer().projectService.list()));

  registerHandler('projects:count', async () =>
    orThrow(await getContainer().projectService.count()),
  );

  registerHandler('projects:get', async ({ id }) =>
    orThrow(await getContainer().projectService.get(id)),
  );

  registerHandler('projects:create', async (input) => {
    const project = orThrow(await getContainer().projectService.create(input));
    getContainer().activityService.recordSafe({
      type: 'project.created',
      message: `Created project "${project.name}"`,
      projectId: project.id,
    });
    return project;
  });

  registerHandler('projects:update', async ({ id, changes }) =>
    orThrow(await getContainer().projectService.update(id, changes)),
  );

  registerHandler('projects:delete', async ({ id }) => {
    const project = orThrow(await getContainer().projectService.get(id));
    const ref = projectStackReference(project);
    const stacks = orThrow(await getContainer().infrastructureService.listManagedStacks());
    if (
      stacks.some(
        (managed) => managed.ref.project === ref.project && managed.ref.stack === ref.stack,
      )
    ) {
      throw new ConflictError(
        'This project still has managed cloud resources. Destroy its infrastructure first, then delete the project.',
        { context: { project: ref.project, stack: ref.stack } },
      );
    }
    orThrow(await getContainer().vpsTargetService.removeManagedProject(id));
    orThrow(await getContainer().projectService.remove(id));
    getContainer().activityService.recordSafe({
      type: 'project.deleted',
      message: 'Deleted a project',
      projectId: id,
    });
    emitEvent('vpsTargets:changed', { reason: 'deleted' });
  });
}
