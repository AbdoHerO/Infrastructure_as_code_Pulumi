import { type Result, toAppError } from '@cloudforge/shared';

/**
 * Unwrap a {@link Result} for use inside an IPC handler: return the value on
 * success, or throw the (typed) error so the registry serializes it into an
 * `IpcResult` failure envelope. The error is normalised to an `AppError`.
 */
export function orThrow<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw toAppError(result.error);
}
