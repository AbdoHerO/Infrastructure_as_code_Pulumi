import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { toAppError, UnauthorizedError } from '@cloudforge/shared';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract.js';
import { getContainer } from '../container.js';
import { log } from '../logging/logger.js';
import { projectOperations, type ProjectOperationLease } from '../project-operation-registry.js';
import { worksWithoutProjectSession } from './session-policy.js';

// These handlers deliberately close the active session and therefore cannot
// hold the ordinary per-request lease that teardown waits on.
const PROJECT_SESSION_TRANSITIONS = new Set<IpcChannel>(['projects:lock', 'projects:delete']);

/** A strongly-typed handler for a single IPC channel. */
export type IpcHandler<C extends IpcChannel> = (
  payload: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/** Who is calling; recorded in the log next to the channel. */
export type DispatchOrigin = 'renderer' | 'mcp';

const handlers = new Map<IpcChannel, IpcHandler<IpcChannel>>();

/**
 * Register a channel handler. The handler's return value (or thrown error) is
 * wrapped into a serialized {@link IpcResult} envelope, so the renderer always
 * receives structured data — success or typed failure — never a raw exception.
 *
 * Every call is logged with its channel, duration and outcome (never its payload
 * or return value, which may contain secrets).
 */
export function registerHandler<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void {
  handlers.set(channel, handler as unknown as IpcHandler<IpcChannel>);
  ipcMain.handle(channel, (_event, payload: IpcRequest<C>) =>
    dispatch(channel, payload, 'renderer'),
  );
}

/**
 * Run a channel's handler. The window and the MCP server both come through here,
 * so a request has the same project boundary, the same operation lease and the
 * same error envelope whichever way it arrived.
 */
export async function dispatch<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
  origin: DispatchOrigin,
): Promise<IpcResult<IpcResponse<C>>> {
  const startedAt = Date.now();
  let requestLease: ProjectOperationLease | undefined;
  try {
    const handler = handlers.get(channel) as IpcHandler<C> | undefined;
    if (!handler) throw new Error(`No handler is registered for ${channel}`);
    const projectId = enforceProjectBoundary(channel, payload);
    if (projectId && !PROJECT_SESSION_TRANSITIONS.has(channel)) {
      requestLease = projectOperations.begin(`ipc:${channel}:${randomUUID()}`, projectId, false);
    }
    const value = await handler(payload);
    log().debug({ event: 'ipc.ok', channel, origin, ms: Date.now() - startedAt }, `IPC ${channel}`);
    return { ok: true, value };
  } catch (error) {
    const appError = toAppError(error);
    log().error(
      {
        event: 'ipc.error',
        channel,
        origin,
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
}

function enforceProjectBoundary(channel: IpcChannel, payload: unknown): string | null {
  if (worksWithoutProjectSession(channel)) return null;
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
