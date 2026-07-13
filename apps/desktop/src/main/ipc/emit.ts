import { webContents } from 'electron';
import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc/contract.js';

/**
 * Push a typed event to every renderer. Used for streamed output (engine logs,
 * deployment progress) that doesn't fit the request/response `invoke` model.
 */
export function emitEvent<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(channel, payload);
  }
}
