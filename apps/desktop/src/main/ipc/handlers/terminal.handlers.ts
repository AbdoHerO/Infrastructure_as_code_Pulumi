import { getContainer } from '../../container.js';
import { emitEvent } from '../emit.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerTerminalHandlers(): void {
  registerHandler('terminal:open', async ({ targetId, sessionId, columns, rows }) =>
    orThrow(
      await getContainer().sshTerminalService.open(
        targetId,
        sessionId,
        { columns, rows },
        {
          onData: (data) => emitEvent('terminal:data', { sessionId, data }),
          onClosed: (reason) =>
            emitEvent('terminal:closed', {
              sessionId,
              ...(reason ? { reason } : {}),
            }),
        },
      ),
    ),
  );
  registerHandler('terminal:write', ({ sessionId, data }) =>
    orThrow(getContainer().sshTerminalService.write(sessionId, data)),
  );
  registerHandler('terminal:resize', ({ sessionId, columns, rows }) =>
    orThrow(getContainer().sshTerminalService.resize(sessionId, { columns, rows })),
  );
  registerHandler('terminal:close', ({ sessionId }) =>
    orThrow(getContainer().sshTerminalService.close(sessionId)),
  );
}
