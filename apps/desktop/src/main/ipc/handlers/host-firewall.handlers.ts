import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

/**
 * The VPS's own firewall, port by port.
 *
 * Payloads carry a saved target id and the ports, nothing else: the host, its
 * pinned key and the SSH credential are loaded in the main process. Opening is
 * additive and idempotent; closing is asked for explicitly in the renderer and
 * refused by the service for the SSH port.
 */
export function registerHostFirewallHandlers(): void {
  const service = (): ReturnType<typeof getContainer>['hostFirewallService'] =>
    getContainer().hostFirewallService;

  registerHandler('hostFirewall:inspect', async ({ targetId }) =>
    orThrow(await service().inspect(targetId)),
  );
  registerHandler('hostFirewall:open', async ({ targetId, ports }) =>
    orThrow(await service().open(targetId, ports)),
  );
  registerHandler('hostFirewall:close', async ({ targetId, ports }) =>
    orThrow(await service().close(targetId, ports)),
  );
}
