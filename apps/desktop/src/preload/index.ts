import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  type IpcChannel,
  IPC_EVENT_CHANNELS,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from '@shared/ipc/contract.js';

/**
 * The single, minimal surface exposed to the renderer. The renderer never sees
 * `ipcRenderer` directly — only this typed `invoke` that returns a serialized
 * {@link IpcResult} envelope, and `subscribe` for allow-listed push events.
 */
const bridge = {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResult<IpcResponse<C>>> {
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<IpcResponse<C>>>;
  },

  /** Subscribe to a main→renderer event channel; returns an unsubscribe fn. */
  subscribe<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
  ): () => void {
    if (!(IPC_EVENT_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`Unknown event channel: ${channel}`);
    }
    const handler = (_event: IpcRendererEvent, payload: IpcEventPayload<C>): void =>
      listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
} as const;

export type CloudForgeBridge = typeof bridge;

// contextIsolation is enabled, so expose via the context bridge (never `window`).
contextBridge.exposeInMainWorld('cloudforge', bridge);
