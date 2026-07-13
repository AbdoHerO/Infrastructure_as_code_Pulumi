import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { toAppError } from '@cloudforge/shared';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract.js';
import { log } from '../logging/logger.js';

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
