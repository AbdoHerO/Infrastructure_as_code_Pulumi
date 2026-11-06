import type { Result } from '@cloudforge/shared';
import type { ApplyResult } from '../ports/infrastructure-engine.js';

/**
 * "Keep trying": apply an approved plan again and again until the cloud provider
 * has room for it. Free servers are often unavailable for days, and a free slot
 * may only last minutes, so clicking Apply by hand rarely gets one.
 *
 * Only failures that time can fix are retried. Anything else (a refused plan, a
 * bad credential, a quota) stops at once and is shown, because repeating it would
 * hide the real problem behind a retry counter.
 */

/** Often enough to catch a slot that opens briefly, and gentle on the provider's API. */
export const KEEP_TRYING_INTERVAL_MS = 2 * 60_000;
/** The longest wait, reached only when the provider asks CloudForge to slow down. */
export const KEEP_TRYING_MAX_INTERVAL_MS = 16 * 60_000;
/** Network errors in a row before giving up: about two hours at the normal interval. */
export const KEEP_TRYING_MAX_ERRORS_IN_A_ROW = 60;

/**
 * - `capacity`: the provider has no room yet;
 * - `throttled`: the provider asks for fewer requests;
 * - `transient`: a network problem or provider hiccup that should pass;
 * - `fatal`: retrying cannot help.
 */
export type ApplyFailureKind = 'capacity' | 'throttled' | 'transient' | 'fatal';

const CAPACITY = /out of (?:host )?capacity|InsufficientInstanceCapacity/i;
const THROTTLED = /\b429-[a-z]|TooManyRequests|RequestLimitExceeded/i;
const TRANSIENT =
  /\b50[0234]-[a-z]|no such host|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|i\/o timeout|TLS handshake timeout|connection (?:reset|refused|timed out)|network is unreachable|context deadline exceeded|currently locked/i;

/** Sort a failed apply by whether trying again can help. */
export function classifyApplyFailure(text: string): ApplyFailureKind {
  if (CAPACITY.test(text)) return 'capacity';
  if (THROTTLED.test(text)) return 'throttled';
  if (TRANSIENT.test(text)) return 'transient';
  return 'fatal';
}

/** Every message of an error and its causes: the engine keeps the detail in the cause. */
export function failureText(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error && messages.length < 5) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length > 0 ? messages.join('\n') : String(error);
}

const MAX_SUMMARY_LENGTH = 300;
const NOISE = /^(?:update failed|\d+ errors? occurred:?|Command failed\b.*)$/i;
const WRAPPER = /^(?:code: -?\d+|stdout:|stderr:|err\?:)/;

/**
 * The line of a long engine failure that says what went wrong. An engine error
 * opens with its exit code and a full copy of the log, so its first line says
 * nothing useful.
 */
export function summarizeEngineFailure(detail: string): string {
  const serviceError = /\b[45]\d\d-[A-Za-z]+\b[^\n]*/.exec(detail)?.[0];
  if (serviceError) return serviceError.trim().slice(0, MAX_SUMMARY_LENGTH);
  // A provider lists its reasons under "1 error occurred:", one per line.
  const listed = /\d+ errors? occurred:?[ \t]*\r?\n\s*\*\s*([^\r\n]+)/.exec(detail)?.[1];
  if (listed) return listed.trim().slice(0, MAX_SUMMARY_LENGTH);
  const lines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reported = lines
    .map((line) => /\berror:\s*(.+)$/i.exec(line)?.[1]?.trim() ?? '')
    .find((line) => line.length > 0 && !NOISE.test(line));
  const fallback = lines.find((line) => !WRAPPER.test(line));
  return (reported ?? fallback ?? 'unknown error').slice(0, MAX_SUMMARY_LENGTH);
}

export type KeepTryingStatus = 'trying' | 'waiting' | 'created' | 'failed' | 'stopped';

export interface KeepTryingState {
  readonly projectId: string;
  readonly status: KeepTryingStatus;
  /** Attempts that have finished. */
  readonly attempts: number;
  readonly startedAt: string;
  readonly lastAttemptAt: string | null;
  /** When the next attempt starts; only set while waiting. */
  readonly nextAttemptAt: string | null;
  readonly message: string;
}

/** Whether the retries are still running. */
export function isKeepTryingActive(state: KeepTryingState | null | undefined): boolean {
  return state?.status === 'trying' || state?.status === 'waiting';
}

export interface KeepTryingOptions {
  readonly projectId: string;
  /** Stops the retries. An attempt already running finishes first. */
  readonly signal: AbortSignal;
  /** One Apply of the approved plan. */
  readonly attempt: () => Promise<Result<ApplyResult, Error>>;
  readonly onChange: (state: KeepTryingState) => void;
  /** Remove what a failed attempt left behind. A failure here never stops the retries. */
  readonly afterFailedAttempt?: () => Promise<void>;
  /** The message to show when stopped, which depends on who stopped it. */
  readonly stopMessage?: () => string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Retry until the plan is applied, a failure cannot be retried, or the signal fires. */
export async function keepTrying(options: KeepTryingOptions): Promise<KeepTryingState> {
  const { projectId, signal } = options;
  const now = options.now ?? ((): Date => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const startedAt = now().toISOString();
  let attempts = 0;
  let lastAttemptAt: string | null = null;
  let interval = KEEP_TRYING_INTERVAL_MS;
  let errorsInARow = 0;
  let message = 'Trying now';

  const publish = (
    status: KeepTryingStatus,
    text: string,
    nextAttemptAt: string | null = null,
  ): KeepTryingState => {
    const state: KeepTryingState = {
      projectId,
      status,
      attempts,
      startedAt,
      lastAttemptAt,
      nextAttemptAt,
      message: text,
    };
    options.onChange(state);
    return state;
  };

  for (;;) {
    if (signal.aborted) return publish('stopped', options.stopMessage?.() ?? 'Stopped');
    lastAttemptAt = now().toISOString();
    publish('trying', message);

    const result = await runAttempt(options.attempt);
    attempts += 1;
    if (result.ok) return publish('created', 'Server created');

    const kind = classifyApplyFailure(failureText(result.error));
    const summary = result.error.message;
    if (kind === 'fatal') return publish('failed', summary);
    if (kind === 'capacity') {
      interval = KEEP_TRYING_INTERVAL_MS;
      errorsInARow = 0;
      message = 'No free capacity yet';
    } else if (kind === 'throttled') {
      interval = Math.min(interval * 2, KEEP_TRYING_MAX_INTERVAL_MS);
      errorsInARow = 0;
      message = 'The provider asked CloudForge to slow down, so it now waits longer';
    } else {
      errorsInARow += 1;
      if (errorsInARow >= KEEP_TRYING_MAX_ERRORS_IN_A_ROW)
        return publish(
          'failed',
          `Gave up after ${String(errorsInARow)} errors in a row: ${summary}`,
        );
      message = `Could not reach the provider: ${summary}`;
    }

    await options.afterFailedAttempt?.().catch(() => undefined);
    if (signal.aborted) continue;
    publish('waiting', message, new Date(now().getTime() + interval).toISOString());
    await sleep(interval, signal);
  }
}

async function runAttempt(
  attempt: () => Promise<Result<ApplyResult, Error>>,
): Promise<Result<ApplyResult, Error>> {
  try {
    return await attempt();
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
