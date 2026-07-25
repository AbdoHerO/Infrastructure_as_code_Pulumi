import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
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

  registerHandler('projects:duplicate', async (input) => {
    const sourceProjectId = getContainer().projectContext.requireActive().projectId;
    return orThrow(
      await getContainer().projectDuplicationService.duplicate(sourceProjectId, input),
    );
  });

  registerHandler('projects:update', async ({ id, changes }) => {
    requireCurrentProject(id);
    return orThrow(await getContainer().projectConfigurationService.update(id, changes));
  });

  registerHandler('projects:delete', async ({ id, confirmationName, passkey }) => {
    requireCurrentProject(id);
    orThrow(
      await getContainer().projectSessionService.deactivateAndRun(
        { passkey },
        async (lease) => {
          if (lease.projectId !== id) throw new UnauthorizedError('Project session changed');
          const project = orThrow(await getContainer().projectService.get(id));
          if (confirmationName !== project.name) {
            throw new UnauthorizedError('Type the exact project name to confirm deletion');
          }
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
          return ref;
        },
        async (lease, ref) => {
          if (lease.projectId !== id) throw new UnauthorizedError('Project session changed');
          // Project-owned targets and runtime-plan settings cascade with the
          // project row. Do not reactivate the context during deletion.
          orThrow(await getContainer().projectService.remove(id));
          await removeProjectFiles(id, ref.project);
        },
      ),
    );
    emitEvent('vpsTargets:changed', { reason: 'deleted' });
  });
}

function requireCurrentProject(projectId: string): void {
  const active = getContainer().projectContext.requireActive();
  if (active.projectId !== projectId) {
    throw new UnauthorizedError('The request belongs to another project');
  }
}

async function removeProjectFiles(projectId: string, pulumiProject: string): Promise<void> {
  const userData = app.getPath('userData');
  await Promise.all([
    rm(join(userData, 'logs', 'projects', projectId), { recursive: true, force: true }),
    rm(join(userData, 'pulumi', 'state', '.pulumi', 'stacks', pulumiProject), {
      recursive: true,
      force: true,
    }),
    rm(join(userData, 'pulumi', 'state', '.pulumi', 'history', pulumiProject), {
      recursive: true,
      force: true,
    }),
    rm(join(userData, 'pulumi', 'state', '.pulumi', 'backups', pulumiProject), {
      recursive: true,
      force: true,
    }),
  ]);
}
