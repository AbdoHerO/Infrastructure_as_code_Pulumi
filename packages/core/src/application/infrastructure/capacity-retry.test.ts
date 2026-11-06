import { describe, expect, it, vi } from 'vitest';
import { err, InfrastructureError, ok, type Result } from '@cloudforge/shared';
import type { ApplyResult } from '../ports/infrastructure-engine.js';
import {
  classifyApplyFailure,
  failureText,
  isKeepTryingActive,
  KEEP_TRYING_INTERVAL_MS,
  KEEP_TRYING_MAX_ERRORS_IN_A_ROW,
  KEEP_TRYING_MAX_INTERVAL_MS,
  keepTrying,
  type KeepTryingState,
  summarizeEngineFailure,
} from './capacity-retry.js';

/** The shape of a real Pulumi failure, with neutral names and made-up identifiers. */
const CAPACITY_FAILURE = `code: -2
 stdout:
 stderr: Command failed with exit code 1: pulumi up --yes --skip-preview --stack production
Updating (production):

 +  oci:Core:Vcn network created (0.35s)
 +  oci:Core:Instance always-free-arm creating (0s) error:   sdk-v2/provider2.go:572: sdk.helper_schema: 500-InternalError, Out of host capacity.
Diagnostics:
  pulumi:pulumi:Stack (demo-project-production):
    error: update failed

  oci:Core:Instance (always-free-arm):
    error:   sdk-v2/provider2.go:572: sdk.helper_schema: 500-InternalError, Out of host capacity.
    OPC request ID: 00000000000000000000000000000000/AAAA/BBBB

 err?: Error: Command failed with exit code 1: pulumi up --yes --skip-preview --stack production`;

const APPLIED: ApplyResult = { outputs: {}, summary: 'succeeded' };

function engineFailure(detail: string): InfrastructureError {
  return new InfrastructureError(`Pulumi operation failed: ${summarizeEngineFailure(detail)}`, {
    cause: new Error(detail),
  });
}

function capacity(): Result<ApplyResult, Error> {
  return err(engineFailure(CAPACITY_FAILURE));
}

interface Harness {
  readonly states: KeepTryingState[];
  readonly sleeps: number[];
  readonly attempt: ReturnType<typeof vi.fn>;
  readonly cleanup: ReturnType<typeof vi.fn>;
  readonly controller: AbortController;
  run(): Promise<KeepTryingState>;
}

function harness(answers: (() => Promise<Result<ApplyResult, Error>>)[]): Harness {
  const states: KeepTryingState[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  const cleanup = vi.fn(() => Promise.resolve());
  let index = 0;
  const attempt = vi.fn(() => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (!answer) throw new Error('no answer');
    return answer();
  });
  return {
    states,
    sleeps,
    attempt,
    cleanup,
    controller,
    run: () =>
      keepTrying({
        projectId: 'project-one',
        signal: controller.signal,
        attempt,
        onChange: (state) => states.push(state),
        afterFailedAttempt: cleanup,
        stopMessage: () => 'You stopped trying',
        now: () => new Date('2030-01-01T10:00:00.000Z'),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
  };
}

describe('summarizeEngineFailure', () => {
  it('finds the reason in a real engine failure, not its exit code', () => {
    expect(summarizeEngineFailure(CAPACITY_FAILURE)).toBe(
      '500-InternalError, Out of host capacity.',
    );
  });

  it('reads a provider error that has no status code', () => {
    const detail = `code: -2
 stdout:
 stderr: Command failed with exit code 1: pulumi up
Diagnostics:
  pulumi:pulumi:Stack (demo):
    error: update failed
  aws:ec2:Instance (web):
    error: creating EC2 Instance: InsufficientInstanceCapacity: try another zone
 err?: Error: Command failed with exit code 1: pulumi up`;
    expect(summarizeEngineFailure(detail)).toBe(
      'creating EC2 Instance: InsufficientInstanceCapacity: try another zone',
    );
  });

  it('reads the reason listed under "1 error occurred"', () => {
    const detail = `code: -2
 stdout:
 stderr: Command failed with exit code 1: pulumi up
    error: Unhandled exception: Error: invocation of oci:Core/getImages:getImages returned an error: 1 error occurred:
    	* can not create client, bad configuration: the private key is not valid
 err?: Error: Command failed with exit code 1: pulumi up`;
    expect(summarizeEngineFailure(detail)).toBe(
      'can not create client, bad configuration: the private key is not valid',
    );
  });

  it('keeps a plain error as it is', () => {
    expect(summarizeEngineFailure('The stack does not exist')).toBe('The stack does not exist');
  });

  it('never reports only the wrapper of a failure', () => {
    expect(summarizeEngineFailure('code: -2\n stdout: \n stderr: ')).toBe('unknown error');
  });

  it('does not return a line too long to read', () => {
    expect(summarizeEngineFailure(`error: ${'x'.repeat(900)}`).length).toBeLessThanOrEqual(300);
  });
});

describe('classifyApplyFailure', () => {
  it.each([
    ['500-InternalError, Out of host capacity.', 'capacity'],
    ['InsufficientInstanceCapacity: try another zone', 'capacity'],
    ['429-TooManyRequests, Too many requests for the tenant', 'throttled'],
    ['RequestLimitExceeded: slow down', 'throttled'],
    ['dial tcp: lookup iaas.example.com: no such host', 'transient'],
    ['net/http: TLS handshake timeout', 'transient'],
    ['503-ServiceUnavailable, try later', 'transient'],
    ['the stack is currently locked by 1 lock(s)', 'transient'],
    ['400-LimitExceeded, the service limit is reached', 'fatal'],
    ['401-NotAuthenticated, the key was rejected', 'fatal'],
    ['404-NotAuthorizedOrNotFound, no permission', 'fatal'],
    ['Run Preview for the current saved plan before Apply.', 'fatal'],
    ['This preview deletes or replaces resources.', 'fatal'],
  ] as const)('%s is %s', (text, kind) => {
    expect(classifyApplyFailure(text)).toBe(kind);
  });

  it('sees capacity through the short message of an engine failure', () => {
    expect(classifyApplyFailure(engineFailure(CAPACITY_FAILURE).message)).toBe('capacity');
  });

  it('reads the causes of an error', () => {
    const error = new InfrastructureError('Pulumi operation failed: unknown error', {
      cause: new Error('dial tcp: i/o timeout'),
    });
    expect(classifyApplyFailure(failureText(error))).toBe('transient');
  });
});

describe('keepTrying', () => {
  it('retries while there is no capacity and stops as soon as the plan is applied', async () => {
    const run = harness([
      () => Promise.resolve(capacity()),
      () => Promise.resolve(capacity()),
      () => Promise.resolve(ok(APPLIED)),
    ]);

    const final = await run.run();

    expect(final.status).toBe('created');
    expect(final.attempts).toBe(3);
    expect(run.attempt).toHaveBeenCalledTimes(3);
    expect(run.sleeps).toEqual([KEEP_TRYING_INTERVAL_MS, KEEP_TRYING_INTERVAL_MS]);
  });

  it('says when the next attempt starts while it waits', async () => {
    const run = harness([() => Promise.resolve(capacity()), () => Promise.resolve(ok(APPLIED))]);

    await run.run();

    const waiting = run.states.find((state) => state.status === 'waiting');
    expect(waiting?.message).toBe('No free capacity yet');
    expect(waiting?.nextAttemptAt).toBe('2030-01-01T10:02:00.000Z');
    expect(isKeepTryingActive(waiting)).toBe(true);
  });

  it('never retries a failure that time cannot fix', async () => {
    const refused = new InfrastructureError('Pulumi operation failed: 400-LimitExceeded, no room');
    const run = harness([() => Promise.resolve(err(refused))]);

    const final = await run.run();

    expect(final.status).toBe('failed');
    expect(final.message).toContain('400-LimitExceeded');
    expect(run.attempt).toHaveBeenCalledTimes(1);
    expect(run.sleeps).toEqual([]);
    expect(isKeepTryingActive(final)).toBe(false);
  });

  it('stops when the approval is withdrawn because the plan changed', async () => {
    const changed = new InfrastructureError(
      'Run Preview for the current saved plan before Apply. The plan changed or the preview expired.',
    );
    const run = harness([() => Promise.resolve(capacity()), () => Promise.resolve(err(changed))]);

    const final = await run.run();

    expect(final.status).toBe('failed');
    expect(final.message).toContain('Run Preview');
    expect(run.attempt).toHaveBeenCalledTimes(2);
  });

  it('waits longer when the provider asks for fewer requests, up to a limit', async () => {
    const throttled = (): Promise<Result<ApplyResult, Error>> =>
      Promise.resolve(err(new InfrastructureError('429-TooManyRequests, slow down')));
    const run = harness([
      throttled,
      throttled,
      throttled,
      throttled,
      throttled,
      () => Promise.resolve(capacity()),
      () => Promise.resolve(ok(APPLIED)),
    ]);

    await run.run();

    expect(run.sleeps.slice(0, 5)).toEqual([
      KEEP_TRYING_INTERVAL_MS * 2,
      KEEP_TRYING_INTERVAL_MS * 4,
      KEEP_TRYING_INTERVAL_MS * 8,
      KEEP_TRYING_MAX_INTERVAL_MS,
      KEEP_TRYING_MAX_INTERVAL_MS,
    ]);
    // Back to the normal pace once the provider answers normally.
    expect(run.sleeps[5]).toBe(KEEP_TRYING_INTERVAL_MS);
  });

  it('rides out a network problem, then gives up if it never ends', async () => {
    const offline = (): Promise<Result<ApplyResult, Error>> =>
      Promise.resolve(err(new InfrastructureError('lookup failed: no such host')));
    const run = harness([offline]);

    const final = await run.run();

    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(KEEP_TRYING_MAX_ERRORS_IN_A_ROW);
    expect(final.message).toContain('errors in a row');
  });

  it('counts only errors in a row, so a long run survives occasional ones', async () => {
    const offline = (): Promise<Result<ApplyResult, Error>> =>
      Promise.resolve(err(new InfrastructureError('lookup failed: no such host')));
    const answers = Array.from({ length: KEEP_TRYING_MAX_ERRORS_IN_A_ROW * 2 }, (_, index) =>
      index % 2 === 0 ? offline : () => Promise.resolve(capacity()),
    );
    const run = harness([...answers, () => Promise.resolve(ok(APPLIED))]);

    expect((await run.run()).status).toBe('created');
  });

  it('cleans up after each failed attempt, and never after the last one', async () => {
    const run = harness([
      () => Promise.resolve(capacity()),
      () => Promise.resolve(capacity()),
      () => Promise.resolve(ok(APPLIED)),
    ]);

    await run.run();

    expect(run.cleanup).toHaveBeenCalledTimes(2);
  });

  it('keeps going when the cleanup fails', async () => {
    const run = harness([() => Promise.resolve(capacity()), () => Promise.resolve(ok(APPLIED))]);
    run.cleanup.mockImplementation(() => Promise.reject(new Error('disk')));

    expect((await run.run()).status).toBe('created');
  });

  it('treats an attempt that throws as a failure, not a crash', async () => {
    const run = harness([() => Promise.reject(new Error('The project was closed'))]);

    const final = await run.run();

    expect(final.status).toBe('failed');
    expect(final.message).toBe('The project was closed');
  });

  it('stops without another attempt once the signal fires', async () => {
    const run = harness([
      () => {
        run.controller.abort();
        return Promise.resolve(capacity());
      },
    ]);

    const final = await run.run();

    expect(final.status).toBe('stopped');
    expect(final.message).toBe('You stopped trying');
    expect(run.attempt).toHaveBeenCalledTimes(1);
    expect(run.sleeps).toEqual([]);
  });

  it('reports a server created by the attempt that was running when stopped', async () => {
    const run = harness([
      () => {
        run.controller.abort();
        return Promise.resolve(ok(APPLIED));
      },
    ]);

    expect((await run.run()).status).toBe('created');
  });

  it('never starts when already stopped', async () => {
    const run = harness([() => Promise.resolve(ok(APPLIED))]);
    run.controller.abort();

    const final = await run.run();

    expect(final.status).toBe('stopped');
    expect(run.attempt).not.toHaveBeenCalled();
  });

  it('wakes from its wait immediately when stopped', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const running = keepTrying({
        projectId: 'project-one',
        signal: controller.signal,
        attempt: () => Promise.resolve(capacity()),
        onChange: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await expect(running).resolves.toMatchObject({ status: 'stopped', attempts: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
