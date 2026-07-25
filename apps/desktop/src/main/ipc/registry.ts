import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { toAppError, UnauthorizedError } from '@cloudforge/shared';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract.js';
import { getContainer } from '../container.js';
import { log } from '../logging/logger.js';
import { projectOperations, type ProjectOperationLease } from '../project-operation-registry.js';

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

// These handlers deliberately close the active session and therefore cannot
// hold the ordinary per-request lease that teardown waits on.
const PROJECT_SESSION_TRANSITIONS = new Set<IpcChannel>(['projects:lock', 'projects:delete']);

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
    let requestLease: ProjectOperationLease | undefined;
    try {
      const projectId = enforceProjectBoundary(channel, payload);
      if (projectId && !PROJECT_SESSION_TRANSITIONS.has(channel)) {
        requestLease = projectOperations.begin(
          `ipc:${channel}:${randomUUID()}`,
          projectId,
          false,
        );
      }
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
    } finally {
      requestLease?.complete();
    }
  });
}

function enforceProjectBoundary(channel: IpcChannel, payload: unknown): string | null {
  if (WITHOUT_PROJECT_SESSION.has(channel)) return null;
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
  return lease.projectId;
}
