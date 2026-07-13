import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/** Register Infrastructure-as-Code engine IPC handlers. */
export function registerInfraHandlers(): void {
  registerHandler('infra:engineStatus', async () => {
    const available = orThrow(await getContainer().infrastructureEngine.isAvailable());
    return { available };
  });
}
