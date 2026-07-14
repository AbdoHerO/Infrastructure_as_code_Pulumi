import { webContents } from 'electron';
import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc/contract.js';
import { log } from '../logging/logger.js';

/**
 * Push a typed event to every renderer. Used for streamed output (engine logs,
 * deployment progress) that doesn't fit the request/response `invoke` model.
 * Streamed lines are also mirrored to the application log file.
 */
export function emitEvent<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  if ('event' in payload) {
    const message = payload.event.message.trimEnd();
    if (message.length > 0) {
      const isError = payload.event.stream === 'stderr' || payload.event.stream === 'error';
      const fields = {
        event: `stream.${channel}`,
        channel,
        stream: payload.event.stream,
        streamId: payload.streamId,
      };
      if (isError) log().warn(fields, message);
      else log().trace(fields, message);
    }
  }

  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(channel, payload);
  }
}
