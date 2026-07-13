import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc/contract.js';

/**
 * The single, minimal surface exposed to the renderer. The renderer never sees
 * `ipcRenderer` directly — only this typed `invoke` that returns a serialized
 * {@link IpcResult} envelope for every channel in the contract.
 */
const bridge = {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResult<IpcResponse<C>>> {
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<IpcResponse<C>>>;
  },
} as const;

export type CloudForgeBridge = typeof bridge;

// contextIsolation is enabled, so expose via the context bridge (never `window`).
contextBridge.exposeInMainWorld('cloudforge', bridge);
