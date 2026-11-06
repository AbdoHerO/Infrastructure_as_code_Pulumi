import { EventEmitter } from 'node:events';
import type { IpcEventChannel, IpcEventPayload } from '../../shared/ipc/contract.js';

/**
 * Everything the main process pushes to the window, available in-process too.
 *
 * The MCP server follows operation logs, terminal output and change events from
 * here, so it sees exactly what the window sees without a second set of emitters.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publishMainEvent<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  bus.emit(channel, payload);
}

/** Follow an event channel; returns the function that stops following it. */
export function onMainEvent<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void,
): () => void {
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}
