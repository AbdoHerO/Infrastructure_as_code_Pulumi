import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

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
    orThrow(await getContainer().projectService.remove(id));
    getContainer().activityService.recordSafe({
      type: 'project.deleted',
      message: 'Deleted a project',
      projectId: id,
    });
  });
}
