/**
 * A functional `Result` type modelling success (`Ok`) or failure (`Err`).
 *
 * CloudForge favours explicit, typed error handling over thrown exceptions across
 * the Application and Domain layers. Exceptions are reserved for truly exceptional,
 * unrecoverable conditions; expected failures flow through `Result`.
 *
 * @typeParam T - The success value type.
 * @typeParam E - The error value type. Defaults to {@link Error}.
 */
export type Result<T, E = Error> = Ok<T> | Err<E>;

/** Discriminated success branch of {@link Result}. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
  readonly error?: undefined;
}

/** Discriminated failure branch of {@link Result}. */
export interface Err<E> {
  readonly ok: false;
  readonly value?: undefined;
  readonly error: E;
}

/** Construct a successful {@link Result}. */
export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

/** Construct a failed {@link Result}. */
export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}

/** Type guard narrowing a {@link Result} to its {@link Ok} branch. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard narrowing a {@link Result} to its {@link Err} branch. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Transform the success value of a {@link Result}, leaving failures untouched.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Transform the error value of a {@link Result}, leaving successes untouched.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Chain a {@link Result}-returning computation onto a success value (monadic bind).
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Extract the success value or return `fallback` on failure.
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Extract the success value or throw. Use only at boundaries where a failure is
 * genuinely unrecoverable (e.g. programmer error), never for expected failures.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error
    ? result.error
    : new Error(`Called unwrap on an Err: ${String(result.error)}`);
}

/**
 * Collapse a {@link Result} into a single value by handling both branches.
 */
export function match<T, E, R>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => R; err: (error: E) => R },
): R {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

/**
 * Run a throwing function and capture the outcome as a {@link Result}.
 * The optional `mapError` adapts unknown thrown values into the desired error type.
 */
export function fromThrowable<T, E = Error>(
  fn: () => T,
  mapError: (error: unknown) => E = (error) => error as E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (error) {
    return err(mapError(error));
  }
}

/**
 * Await a promise and capture the outcome as a {@link Result}, never rejecting.
 */
export async function fromPromise<T, E = Error>(
  promise: Promise<T>,
  mapError: (error: unknown) => E = (error) => error as E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (error) {
    return err(mapError(error));
  }
}

/**
 * Combine an array of results into a single result of an array.
 * Short-circuits on the first failure.
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
