import { BrowserWindow, Notification, powerSaveBlocker } from 'electron';
import {
  type ApplyResult,
  classifyApplyFailure,
  type EngineEvent,
  failureText,
  keepTrying,
  type KeepTryingState,
  type StackReference,
} from '@cloudforge/core';
import type { Result } from '@cloudforge/shared';
import { getContainer } from '../container.js';
import { emitEvent } from '../ipc/emit.js';
import { log } from '../logging/logger.js';
import { projectOperations, type ProjectOperationLease } from '../project-operation-registry.js';

export interface KeepTryingRequest {
  readonly projectId: string;
  readonly streamId: string;
  readonly previewToken: string;
  readonly ref: StackReference;
}

interface Run {
  stopRequested: boolean;
}

const runs = new Map<string, Run>();
/** The last state of each project, so the page can show the result when you come back. */
const lastStates = new Map<string, KeepTryingState>();

function runKey(projectId: string): string {
  return `infra:keepTrying:${projectId}`;
}

/** Whether a project is retrying now; its other cloud operations wait until it stops. */
export function isKeepTrying(projectId: string): boolean {
  return runs.has(projectId);
}

export function keepTryingStatus(projectId: string): KeepTryingState | null {
  return lastStates.get(projectId) ?? null;
}

/**
 * Start retrying in the background and return right away. Only one run per project.
 *
 * Credentials only open for the active project, so a run cannot outlive it. The
 * wait between attempts holds an abortable lease, so opening another project or
 * locking this one ends the run instead of being refused for days. An attempt in
 * progress holds a non-abortable lease like any Apply, so that those actions wait
 * for it and its result cannot reach another project.
 */
export function startKeepTrying(request: KeepTryingRequest): KeepTryingState {
  const { projectId } = request;
  const running = runs.has(projectId) ? lastStates.get(projectId) : undefined;
  if (running) return running;
  const run: Run = { stopRequested: false };
  const lease = projectOperations.begin(runKey(projectId), projectId, true);
  runs.set(projectId, run);
  // The first state is published before the first await, so it is there to return.
  void supervise(request, run, lease);
  const state = lastStates.get(projectId);
  if (!state) throw new Error('The retries did not start');
  return state;
}

/** Stop after the attempt in progress, if any; its result is still reported. */
export function stopKeepTrying(projectId: string): KeepTryingState | null {
  const run = runs.get(projectId);
  if (run) {
    run.stopRequested = true;
    projectOperations.cancel(runKey(projectId));
  }
  return keepTryingStatus(projectId);
}

/** No new attempts while the app closes. */
export function stopAllKeepTrying(): void {
  for (const projectId of runs.keys()) projectOperations.cancel(runKey(projectId));
}

async function supervise(
  request: KeepTryingRequest,
  run: Run,
  lease: ProjectOperationLease,
): Promise<void> {
  const { projectId, ref } = request;
  const startedAt = new Date();
  // Windows would otherwise put the computer to sleep during a long run, and a
  // sleeping computer catches no free server. The screen can still turn off.
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  let applied: ApplyResult | null = null;
  try {
    const final = await keepTrying({
      projectId,
      signal: lease.signal ?? new AbortController().signal,
      attempt: async () => {
        const result = await attempt(request);
        if (result.ok) applied = result.value;
        return result;
      },
      onChange: (state) => {
        lastStates.set(projectId, state);
        emitEvent('infra:tryingChanged', state);
        // One short line per attempt, because the attempt's own output is dropped.
        if (state.status === 'waiting') {
          log().debug(
            { event: 'infra.keep-trying.attempt', attempts: state.attempts, projectId },
            state.message,
          );
        }
      },
      afterFailedAttempt: async () => {
        const pruned = await getContainer().infrastructureService.pruneAttemptHistory(
          ref,
          startedAt,
        );
        if (!pruned.ok) {
          log().warn(
            { event: 'infra.keep-trying.prune-failed', err: pruned.error, projectId },
            'Could not clean up after a failed attempt',
          );
        }
      },
      stopMessage: () =>
        run.stopRequested
          ? 'You stopped trying'
          : 'Stopped because this project was closed or another project was opened',
    });
    report(final, applied);
  } catch (cause) {
    log().error(
      { event: 'infra.keep-trying.crashed', err: cause, projectId },
      'Keep trying crashed',
    );
  } finally {
    powerSaveBlocker.stop(blocker);
    runs.delete(projectId);
    lease.complete();
  }
}

/**
 * One Apply, through the same service as the button, so the same checks run every
 * time: a changed plan or a preview that deletes or replaces resources is refused.
 *
 * A failed attempt's output stays out of the log: hundreds of copies of the same
 * failure a day would bury everything else in it.
 */
async function attempt(request: KeepTryingRequest): Promise<Result<ApplyResult, Error>> {
  const { projectId, streamId, previewToken, ref } = request;
  const lease = projectOperations.begin(`${runKey(projectId)}:attempt`, projectId, false);
  const output: EngineEvent[] = [];
  try {
    const result = await getContainer().infrastructureService.apply(
      ref,
      projectId,
      previewToken,
      (event) => {
        output.push(event);
      },
    );
    if (result.ok || classifyApplyFailure(failureText(result.error)) === 'fatal') {
      for (const event of output) emitEvent('engine:log', { streamId, event });
    }
    return result;
  } finally {
    lease.complete();
  }
}

function report(final: KeepTryingState, applied: ApplyResult | null): void {
  const { attempts, projectId } = final;
  const tries = `${String(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}`;
  log().info(
    { event: 'infra.keep-trying.finished', status: final.status, attempts, projectId },
    'Keep trying finished',
  );
  if (final.status === 'created') {
    record('infrastructure.applied', `Applied infrastructure plan after ${tries}`, projectId);
    if (applied?.targetSync?.count) emitEvent('vpsTargets:changed', { reason: 'synchronized' });
    notify('Your server is ready', `CloudForge created it after ${tries}.`);
  } else if (final.status === 'failed') {
    record(
      'infrastructure.keep_trying.failed',
      `Stopped trying to create the server after ${tries}`,
      projectId,
    );
    notify('CloudForge stopped trying to create your server', final.message);
  } else {
    record(
      'infrastructure.keep_trying.stopped',
      `Stopped trying to create the server after ${tries}`,
      projectId,
    );
  }
}

function record(type: string, message: string, projectId: string): void {
  try {
    getContainer().activityService.recordSafe({ type, message, projectId });
  } catch {
    // The app is closing; there is no activity feed left to write to.
  }
}

/** The run can take days, so its result has to reach someone who is not watching. */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  notification.show();
}
