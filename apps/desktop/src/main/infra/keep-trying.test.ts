import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, InfrastructureError, ok, type Result } from '@cloudforge/shared';
import type { ApplyResult, EngineEventSink, KeepTryingState } from '@cloudforge/core';

const electron = vi.hoisted(() => ({
  shown: [] as { title: string; body: string }[],
  blockers: new Set<number>(),
}));

vi.mock('electron', () => {
  class Notification {
    static isSupported(): boolean {
      return true;
    }
    constructor(private readonly options: { title: string; body: string }) {}
    on = vi.fn();
    show(): void {
      electron.shown.push(this.options);
    }
  }
  let next = 0;
  return {
    BrowserWindow: { getAllWindows: () => [] },
    Notification,
    powerSaveBlocker: {
      start: () => {
        next += 1;
        electron.blockers.add(next);
        return next;
      },
      stop: (id: number) => electron.blockers.delete(id),
    },
  };
});

const emitted = vi.hoisted(() => ({
  events: [] as { channel: string; payload: unknown }[],
}));

vi.mock('../ipc/emit.js', () => ({
  emitEvent: (channel: string, payload: unknown) => emitted.events.push({ channel, payload }),
}));

vi.mock('../logging/logger.js', () => ({
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const services = vi.hoisted(() => ({
  apply: vi.fn(),
  prune: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../container.js', () => ({
  getContainer: () => ({
    infrastructureService: { apply: services.apply, pruneAttemptHistory: services.prune },
    activityService: { recordSafe: services.record },
  }),
}));

import { projectOperations } from '../project-operation-registry.js';
import {
  isKeepTrying,
  keepTryingStatus,
  startKeepTrying,
  stopAllKeepTrying,
  stopKeepTrying,
} from './keep-trying.js';

const PROJECT = 'project-one';
const ref = { project: 'demo', stack: 'production' };
const request = { projectId: PROJECT, streamId: 'stream', previewToken: 'token', ref };
const APPLIED: ApplyResult = {
  outputs: {},
  summary: 'succeeded',
  targetSync: { count: 1, warnings: [] },
};

function noCapacity(): Result<ApplyResult, Error> {
  return err(
    new InfrastructureError('Pulumi operation failed: 500-InternalError, Out of host capacity.'),
  );
}

function statesOf(status: KeepTryingState['status']): KeepTryingState[] {
  return emitted.events
    .filter((event) => event.channel === 'infra:tryingChanged')
    .map((event) => event.payload as KeepTryingState)
    .filter((state) => state.status === status);
}

/** Let the run reach its next wait: real promises, fake timers. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('keep trying in the app', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electron.shown.length = 0;
    emitted.events.length = 0;
    services.apply.mockReset();
    services.prune.mockReset();
    services.prune.mockResolvedValue(ok(undefined));
    services.record.mockReset();
  });

  afterEach(async () => {
    stopKeepTrying(PROJECT);
    await settle();
    vi.useRealTimers();
    expect(isKeepTrying(PROJECT)).toBe(false);
  });

  it('applies with the approved token again and again until the server exists', async () => {
    services.apply
      .mockResolvedValueOnce(noCapacity())
      .mockResolvedValueOnce(noCapacity())
      .mockResolvedValueOnce(ok(APPLIED));

    const first = startKeepTrying(request);

    expect(first.status).toBe('trying');
    expect(isKeepTrying(PROJECT)).toBe(true);
    await settle();
    expect(keepTryingStatus(PROJECT)?.status).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(keepTryingStatus(PROJECT)?.status).toBe('created');
    expect(keepTryingStatus(PROJECT)?.attempts).toBe(3);
    expect(services.apply).toHaveBeenCalledTimes(3);
    for (const call of services.apply.mock.calls) {
      expect(call.slice(0, 3)).toEqual([ref, PROJECT, 'token']);
      // Never the option that would accept deleting or replacing resources.
      expect(call[4]).toBeUndefined();
    }
    expect(isKeepTrying(PROJECT)).toBe(false);
  });

  it('tells you when the server is ready, and updates the saved targets', async () => {
    services.apply.mockResolvedValueOnce(ok(APPLIED));

    startKeepTrying(request);
    await settle();

    expect(electron.shown).toEqual([
      { title: 'Your server is ready', body: 'CloudForge created it after 1 attempt.' },
    ]);
    expect(emitted.events.some((event) => event.channel === 'vpsTargets:changed')).toBe(true);
    expect(services.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'infrastructure.applied', projectId: PROJECT }),
    );
  });

  it('tells you when it gives up', async () => {
    services.apply.mockResolvedValueOnce(
      err(new InfrastructureError('Pulumi operation failed: 401-NotAuthenticated, bad key')),
    );

    startKeepTrying(request);
    await settle();

    expect(keepTryingStatus(PROJECT)?.status).toBe('failed');
    expect(electron.shown[0]?.body).toContain('401-NotAuthenticated');
  });

  it('keeps the output of failed attempts out of the log', async () => {
    services.apply.mockImplementation(
      (_ref: unknown, _project: unknown, _token: unknown, sink: EngineEventSink) => {
        sink({ stream: 'stderr', message: 'a long copy of the failure' });
        return Promise.resolve(noCapacity());
      },
    );

    startKeepTrying(request);
    await settle();
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(services.apply).toHaveBeenCalledTimes(2);
    expect(emitted.events.some((event) => event.channel === 'engine:log')).toBe(false);
  });

  it('shows the output of the attempt that made the server', async () => {
    services.apply.mockImplementation(
      (_ref: unknown, _project: unknown, _token: unknown, sink: EngineEventSink) => {
        sink({ stream: 'stdout', message: 'instance created' });
        return Promise.resolve(ok(APPLIED));
      },
    );

    startKeepTrying(request);
    await settle();

    expect(emitted.events).toContainEqual({
      channel: 'engine:log',
      payload: { streamId: 'stream', event: { stream: 'stdout', message: 'instance created' } },
    });
  });

  it('cleans up after a failed attempt, from the start of this run only', async () => {
    services.apply.mockResolvedValue(noCapacity());
    const before = Date.now();

    startKeepTrying(request);
    await settle();

    expect(services.prune).toHaveBeenCalledTimes(1);
    const [prunedRef, since] = services.prune.mock.calls[0] as [unknown, Date];
    expect(prunedRef).toEqual(ref);
    expect(since.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stays running when the cleanup fails', async () => {
    services.apply.mockResolvedValue(noCapacity());
    services.prune.mockResolvedValue(err(new InfrastructureError('disk')));

    startKeepTrying(request);
    await settle();

    expect(keepTryingStatus(PROJECT)?.status).toBe('waiting');
  });

  it('does not start a second run for the same project', async () => {
    services.apply.mockResolvedValue(noCapacity());

    startKeepTrying(request);
    await settle();
    const again = startKeepTrying(request);
    await settle();

    expect(again.status).toBe('waiting');
    expect(services.apply).toHaveBeenCalledTimes(1);
  });

  it('stops without another attempt when you press Stop', async () => {
    services.apply.mockResolvedValue(noCapacity());

    startKeepTrying(request);
    await settle();
    stopKeepTrying(PROJECT);
    await settle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(services.apply).toHaveBeenCalledTimes(1);
    expect(keepTryingStatus(PROJECT)?.status).toBe('stopped');
    expect(keepTryingStatus(PROJECT)?.message).toBe('You stopped trying');
    expect(electron.shown).toEqual([]);
  });

  it('ends when you open another project during the wait, and says why', async () => {
    services.apply.mockResolvedValue(noCapacity());

    startKeepTrying(request);
    await settle();
    await expect(projectOperations.deactivate(PROJECT)).resolves.toBeUndefined();

    expect(isKeepTrying(PROJECT)).toBe(false);
    expect(statesOf('stopped')[0]?.message).toContain('another project was opened');
  });

  it('makes switching project wait while an attempt is running', async () => {
    let finish: (result: Result<ApplyResult, Error>) => void = () => undefined;
    services.apply.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    startKeepTrying(request);
    await settle();
    await expect(projectOperations.deactivate(PROJECT)).rejects.toThrow(
      'Wait for the active operation',
    );
    expect(isKeepTrying(PROJECT)).toBe(true);

    finish(noCapacity());
    await settle();
    await expect(projectOperations.deactivate(PROJECT)).resolves.toBeUndefined();
    expect(isKeepTrying(PROJECT)).toBe(false);
  });

  it('reports a server made by the attempt that was running when you pressed Stop', async () => {
    let finish: (result: Result<ApplyResult, Error>) => void = () => undefined;
    services.apply.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    startKeepTrying(request);
    await settle();
    stopKeepTrying(PROJECT);
    finish(ok(APPLIED));
    await settle();

    expect(keepTryingStatus(PROJECT)?.status).toBe('created');
    expect(electron.shown[0]?.title).toBe('Your server is ready');
  });

  it('lets the computer sleep again once it ends', async () => {
    services.apply.mockResolvedValue(noCapacity());

    startKeepTrying(request);
    await settle();
    expect(electron.blockers.size).toBe(1);

    stopKeepTrying(PROJECT);
    await settle();
    expect(electron.blockers.size).toBe(0);
  });

  it('makes no new attempts while the app closes', async () => {
    services.apply.mockResolvedValue(noCapacity());

    startKeepTrying(request);
    await settle();
    stopAllKeepTrying();
    await settle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(services.apply).toHaveBeenCalledTimes(1);
    expect(isKeepTrying(PROJECT)).toBe(false);
  });

  it('can run again after it ended', async () => {
    services.apply.mockResolvedValueOnce(noCapacity()).mockResolvedValueOnce(ok(APPLIED));

    startKeepTrying(request);
    await settle();
    stopKeepTrying(PROJECT);
    await settle();

    expect(startKeepTrying(request).status).toBe('trying');
    await settle();
    expect(keepTryingStatus(PROJECT)?.status).toBe('created');
  });
});
