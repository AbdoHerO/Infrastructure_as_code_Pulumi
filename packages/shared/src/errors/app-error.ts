/**
 * Stable, machine-readable error codes shared across every layer and the IPC
 * boundary. Extend deliberately — codes are part of the application contract.
 */
export const ErrorCode = {
  UNKNOWN: 'UNKNOWN',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  PROVIDER: 'PROVIDER',
  INFRASTRUCTURE: 'INFRASTRUCTURE',
  DEPLOYMENT: 'DEPLOYMENT',
  CREDENTIAL: 'CREDENTIAL',
  ENCRYPTION: 'ENCRYPTION',
  PERSISTENCE: 'PERSISTENCE',
  IPC: 'IPC',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Additional structured context attached to an error, safe to log and serialize. */
export type ErrorContext = Record<string, unknown>;

/** Plain, serializable representation of an {@link AppError} for IPC and logging. */
export interface SerializedAppError {
  readonly name: string;
  readonly code: ErrorCode;
  readonly message: string;
  readonly context?: ErrorContext;
  readonly cause?: SerializedAppError | { readonly message: string } | undefined;
}

/**
 * Base class for all expected, domain-level failures in CloudForge.
 *
 * `AppError`s are serialized across the Electron IPC boundary, so they carry a
 * stable {@link ErrorCode}, a human-readable message and optional structured
 * context — never non-serializable payloads.
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;

  readonly context: ErrorContext | undefined;

  constructor(message: string, options?: { cause?: unknown; context?: ErrorContext }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.context = options?.context;
    // Restore prototype chain when transpiled to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialize into a plain object suitable for IPC transport and structured logs. */
  toJSON(): SerializedAppError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.context ? { context: this.context } : {}),
      ...(this.cause !== undefined ? { cause: serializeCause(this.cause) } : {}),
    };
  }
}

function serializeCause(cause: unknown): SerializedAppError | { message: string } | undefined {
  if (cause instanceof AppError) return cause.toJSON();
  if (cause instanceof Error) return { message: cause.message };
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === 'string') return { message: cause };
  return { message: safeStringify(cause) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'unknown';
  } catch {
    return 'unserializable value';
  }
}

/** Invalid input or violated invariant. */
export class ValidationError extends AppError {
  readonly code = ErrorCode.VALIDATION;
}

/** A requested resource does not exist. */
export class NotFoundError extends AppError {
  readonly code = ErrorCode.NOT_FOUND;
}

/** A resource already exists or the operation conflicts with current state. */
export class ConflictError extends AppError {
  readonly code = ErrorCode.CONFLICT;
}

/** Authentication is missing or invalid. */
export class UnauthorizedError extends AppError {
  readonly code = ErrorCode.UNAUTHORIZED;
}

/** Authenticated but not permitted. */
export class ForbiddenError extends AppError {
  readonly code = ErrorCode.FORBIDDEN;
}

/** An operation exceeded its allotted time. */
export class TimeoutError extends AppError {
  readonly code = ErrorCode.TIMEOUT;
}

/** An operation was cancelled by the user or system. */
export class CancelledError extends AppError {
  readonly code = ErrorCode.CANCELLED;
}

/** A cloud provider SDK/API returned an error. */
export class ProviderError extends AppError {
  readonly code = ErrorCode.PROVIDER;
}

/** Infrastructure provisioning (Pulumi) failed. */
export class InfrastructureError extends AppError {
  readonly code = ErrorCode.INFRASTRUCTURE;
}

/** Deployment (SSH/Ansible/Docker) failed. */
export class DeploymentError extends AppError {
  readonly code = ErrorCode.DEPLOYMENT;
}

/** Credential handling failed (missing, malformed, etc.). */
export class CredentialError extends AppError {
  readonly code = ErrorCode.CREDENTIAL;
}

/** Encryption or decryption failed. */
export class EncryptionError extends AppError {
  readonly code = ErrorCode.ENCRYPTION;
}

/** Persistence/database operation failed. */
export class PersistenceError extends AppError {
  readonly code = ErrorCode.PERSISTENCE;
}

/** IPC transport or contract violation. */
export class IpcError extends AppError {
  readonly code = ErrorCode.IPC;
}

/** Catch-all for unclassified failures. Prefer a specific subclass where possible. */
export class UnknownError extends AppError {
  readonly code = ErrorCode.UNKNOWN;
}

/**
 * Normalise any thrown value into an {@link AppError}. Unknown values become an
 * {@link UnknownError} while preserving the original as `cause`.
 */
export function toAppError(value: unknown): AppError {
  if (value instanceof AppError) return value;
  if (value instanceof Error) {
    return new UnknownError(value.message, { cause: value });
  }
  return new UnknownError(typeof value === 'string' ? value : 'An unknown error occurred', {
    context: { original: value },
  });
}
