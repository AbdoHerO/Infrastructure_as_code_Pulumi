import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerNginxHandlers(): void {
  registerHandler('nginx:inspect', async ({ targetId }) =>
    orThrow(await getContainer().nginxService.inspect(targetId)),
  );
  registerHandler('nginx:listSites', async ({ targetId }) =>
    orThrow(await getContainer().nginxService.listSites(targetId)),
  );
  registerHandler('nginx:saveSite', async ({ targetId, site, streamId }) =>
    orThrow(
      await getContainer().nginxService.saveSite(targetId, site, (event) =>
        emitEvent('nginx:log', { streamId, event }),
      ),
    ),
  );
  registerHandler('nginx:removeSite', async ({ targetId, domain, streamId }) =>
    orThrow(
      await getContainer().nginxService.removeSite(targetId, domain, (event) =>
        emitEvent('nginx:log', { streamId, event }),
      ),
    ),
  );
  registerHandler('nginx:readConfig', async ({ targetId }) => ({
    content: orThrow(await getContainer().nginxService.readMainConfig(targetId)),
  }));
  registerHandler('nginx:saveConfig', async ({ targetId, content, streamId }) =>
    orThrow(
      await getContainer().nginxService.saveMainConfig(targetId, content, (event) =>
        emitEvent('nginx:log', { streamId, event }),
      ),
    ),
  );
  registerHandler('nginx:reload', async ({ targetId, streamId }) =>
    orThrow(
      await getContainer().nginxService.reload(targetId, (event) =>
        emitEvent('nginx:log', { streamId, event }),
      ),
    ),
  );
  registerHandler('nginx:liveStatus', async ({ targetId }) =>
    orThrow(await getContainer().nginxService.liveStatus(targetId)),
  );
  registerHandler('nginx:logs', async ({ targetId, query }) => ({
    lines: orThrow(await getContainer().nginxService.readLogs(targetId, query)),
  }));
  registerHandler('nginx:backups', async ({ targetId }) =>
    orThrow(await getContainer().nginxService.listBackups(targetId)),
  );
  registerHandler('nginx:readBackupConfig', async ({ targetId, backupId }) => ({
    content: orThrow(await getContainer().nginxService.readBackupConfig(targetId, backupId)),
  }));
  registerHandler('nginx:restore', async ({ targetId, backupId, streamId }) =>
    orThrow(
      await getContainer().nginxService.restore(targetId, backupId, (event) =>
        emitEvent('nginx:log', { streamId, event }),
      ),
    ),
  );
}
