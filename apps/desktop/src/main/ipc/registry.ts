import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { toAppError, UnauthorizedError } from '@cloudforge/shared';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract.js';
import { getContainer } from '../container.js';
import { log } from '../logging/logger.js';

const WITHOUT_PROJECT_SESSION = new Set<IpcChannel>([
  'app:getInfo',
  'app:ping',
  'app:openExternal',
  'app:copyDiagnostics',
  'app:copyText',
  'logs:report',
  'projects:picker',
  'projects:count',
  'projects:session',
  'projects:unlock',
  'projects:create',
  'updates:state',
  'updates:check',
  'updates:download',
  'updates:install',
]);

/** A strongly-typed handler for a single IPC channel. */
export type IpcHandler<C extends IpcChannel> = (
  payload: IpcRequest<C>,
  event: IpcMainInvokeEvent,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/**
 * Register a channel handler. The handler's return value (or thrown error) is
 * wrapped into a serialized {@link IpcResult} envelope, so the renderer always
 * receives structured data — success or typed failure — never a raw exception.
 *
 * Every call is logged with its channel, duration and outcome (never its payload
 * or return value, which may contain secrets).
 */
export function registerHandler<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void {
  ipcMain.handle(channel, async (event, payload: IpcRequest<C>): Promise<IpcResult<unknown>> => {
    const startedAt = Date.now();
    try {
      enforceProjectBoundary(channel, payload);
      const value = await handler(payload, event);
      log().debug({ event: 'ipc.ok', channel, ms: Date.now() - startedAt }, `IPC ${channel}`);
      return { ok: true, value };
    } catch (error) {
      const appError = toAppError(error);
      log().error(
        {
          event: 'ipc.error',
          channel,
          code: appError.code,
          err: appError,
          context: appError.context,
          ms: Date.now() - startedAt,
        },
        `IPC ${channel} failed`,
      );
      return { ok: false, error: appError.toJSON() };
    }
  });
}

function enforceProjectBoundary(channel: IpcChannel, payload: unknown): void {
  if (WITHOUT_PROJECT_SESSION.has(channel)) return;
  const lease = getContainer().projectContext.requireActive();
  if (
    payload &&
    typeof payload === 'object' &&
    'projectId' in payload &&
    typeof payload.projectId === 'string' &&
    payload.projectId !== lease.projectId
  ) {
    throw new UnauthorizedError('The request belongs to another project');
  }
}
