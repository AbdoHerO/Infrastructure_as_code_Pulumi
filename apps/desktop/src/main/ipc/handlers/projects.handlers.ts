import { ConflictError, UnauthorizedError } from '@cloudforge/shared';
import { getContainer } from '../../container.js';
import { projectStackReference } from '../../infra/stack-reference.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';
import { emitEvent } from '../emit.js';

/** Register the Projects module IPC handlers. */
export function registerProjectHandlers(): void {
  registerHandler('projects:picker', async () =>
    orThrow(await getContainer().projectService.listForPicker()),
  );

  registerHandler('projects:list', async () => {
    const session = orThrow(await getContainer().projectSessionService.current());
    if (!session) throw new UnauthorizedError('Unlock a project first');
    return [session.project];
  });

  registerHandler('projects:count', async () =>
    orThrow(await getContainer().projectService.count()),
  );

  registerHandler('projects:session', async () =>
    orThrow(await getContainer().projectSessionService.current()),
  );

  registerHandler('projects:unlock', async ({ id, passkey }) =>
    orThrow(await getContainer().projectSessionService.unlock(id, passkey)),
  );

  registerHandler('projects:lock', async () =>
    orThrow(await getContainer().projectSessionService.lock()),
  );

  registerHandler('projects:changePasskey', async ({ currentPasskey, newPasskey }) =>
    orThrow(await getContainer().projectSessionService.changePasskey(currentPasskey, newPasskey)),
  );

  registerHandler('projects:get', async ({ id }) => {
    requireCurrentProject(id);
    return orThrow(await getContainer().projectService.get(id));
  });

  registerHandler('projects:create', async (input) => {
    const project = orThrow(await getContainer().projectService.create(input));
    getContainer().activityService.recordSafe({
      type: 'project.created',
      message: `Created project "${project.name}"`,
      projectId: project.id,
    });
    return project;
  });

  registerHandler('projects:update', async ({ id, changes }) => {
    requireCurrentProject(id);
    return orThrow(await getContainer().projectConfigurationService.update(id, changes));
  });

  registerHandler('projects:delete', async ({ id }) => {
    requireCurrentProject(id);
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
    orThrow(await getContainer().projectSessionService.lock());
    orThrow(await getContainer().projectService.remove(id));
    emitEvent('vpsTargets:changed', { reason: 'deleted' });
  });
}

function requireCurrentProject(projectId: string): void {
  const active = getContainer().projectContext.requireActive();
  if (active.projectId !== projectId) {
    throw new UnauthorizedError('The request belongs to another project');
  }
}
