import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register the Activity / Logs IPC handlers. */
export function registerActivityHandlers(): void {
  registerHandler('activity:list', async ({ limit }) =>
    orThrow(await getContainer().activityService.list(limit ?? 200)),
  );
}
