import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerSslHandlers(): void {
  registerHandler('ssl:verifyDns', async ({ targetId, domain }) =>
    orThrow(await getContainer().sslService.verifyDns(targetId, domain)),
  );
  registerHandler('ssl:list', async ({ targetId, certificateVolume }) =>
    orThrow(await getContainer().sslService.list(targetId, certificateVolume)),
  );
  registerHandler('ssl:issue', async ({ targetId, config, streamId }) =>
    orThrow(
      await getContainer().sslService.issue(targetId, config, (event) =>
        emitEvent('ssl:log', { streamId, event }),
      ),
    ),
  );
  registerHandler('ssl:export', async ({ targetId, certificateVolume, domain, format }) =>
    orThrow(await getContainer().sslService.export(targetId, certificateVolume, domain, format)),
  );
}
