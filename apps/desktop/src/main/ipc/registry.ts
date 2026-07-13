import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { toAppError } from '@cloudforge/shared';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract.js';

/** A strongly-typed handler for a single IPC channel. */
export type IpcHandler<C extends IpcChannel> = (
  payload: IpcRequest<C>,
  event: IpcMainInvokeEvent,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/**
 * Register a channel handler. The handler's return value (or thrown error) is
 * wrapped into a serialized {@link IpcResult} envelope, so the renderer always
 * receives structured data — success or typed failure — never a raw exception.
 */
export function registerHandler<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void {
  ipcMain.handle(channel, async (event, payload: IpcRequest<C>): Promise<IpcResult<unknown>> => {
    try {
      const value = await handler(payload, event);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: toAppError(error).toJSON() };
    }
  });
}
