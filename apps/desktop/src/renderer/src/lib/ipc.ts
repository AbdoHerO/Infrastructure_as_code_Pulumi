import { err, ok, type Result, type SerializedAppError } from '@cloudforge/shared';
import type { IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc/contract.js';

/** Error thrown by {@link invoke} carrying the serialized main-process error. */
export class IpcCallError extends Error {
  readonly code: string;

  constructor(readonly serialized: SerializedAppError) {
    super(serialized.message);
    this.name = 'IpcCallError';
    this.code = serialized.code;
  }
}

/**
 * Invoke an IPC channel, throwing {@link IpcCallError} on failure. This is the
 * idiomatic form for TanStack Query, whose error handling expects thrown values.
 */
export async function invoke<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  const result = await window.cloudforge.invoke(channel, payload);
  if (result.ok) return result.value;
  throw new IpcCallError(result.error);
}

/**
 * Invoke an IPC channel and return a {@link Result} instead of throwing — for
 * call sites that prefer explicit branching over exceptions.
 */
export async function tryInvoke<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<Result<IpcResponse<C>, SerializedAppError>> {
  const result = await window.cloudforge.invoke(channel, payload);
  return result.ok ? ok(result.value) : err(result.error);
}
