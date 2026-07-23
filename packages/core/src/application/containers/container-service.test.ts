import { describe, expect, it, vi } from 'vitest';
import { DeploymentError, err, ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { ContainerManager } from '../ports/container-manager.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { RuntimeInspector } from '../ports/runtime-inspector.js';
import { ContainerService } from './container-service.js';

const TARGET_ID = '3f1c2b8e-9a4d-4e5f-8b7a-1c2d3e4f5a6b';
const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:pinned',
};

function build(overrides: { readonly action?: ContainerManager['action'] } = {}) {
  const resolve = vi.fn().mockResolvedValue(ok(target));
  const list = vi.fn().mockResolvedValue(ok([]));
  const action = overrides.action ?? vi.fn().mockResolvedValue(ok(undefined));
  const logs = vi.fn().mockResolvedValue(ok(''));
  const stats = vi.fn().mockResolvedValue(ok({}));
  const deployCompose = vi.fn().mockResolvedValue(ok(undefined));
  const inspect = vi.fn().mockResolvedValue(ok({ targetId: TARGET_ID, containers: [] }));
  const recordSafe = vi.fn();

  const containers: ContainerManager = { list, action, logs, stats, deployCompose };
  const inspector: RuntimeInspector = { inspect };
  const service = new ContainerService({ resolve }, containers, inspector, {
    recordSafe,
  } as unknown as ActivityService);
  return { service, resolve, list, action, logs, stats, deployCompose, inspect, recordSafe };
}

describe('ContainerService', () => {
  it('resolves the pinned target from its id instead of trusting the caller', async () => {
    // The renderer used to supply host and hostKeySha256 itself, which lets a
    // caller name the fingerprint it wants verified — defeating the pin.
    const { service, resolve, list } = build();

    await service.list(TARGET_ID);

    expect(resolve).toHaveBeenCalledWith(TARGET_ID);
    expect(list).toHaveBeenCalledWith(target);
  });

  it.each(['not-a-uuid', '', '../../etc/passwd'])('rejects %s as a target id', async (id) => {
    const { service, list } = build();

    expect((await service.list(id)).ok).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it('surfaces a target that cannot be resolved without contacting Docker', async () => {
    const { list } = build();
    const failing = new ContainerService(
      { resolve: vi.fn().mockResolvedValue(err(new DeploymentError('no credential'))) },
      { list } as unknown as ContainerManager,
      { inspect: vi.fn() },
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    expect((await failing.list(TARGET_ID)).ok).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it.each(['start', 'stop', 'restart', 'remove'] as const)(
    'records %s in Activity',
    async (operation) => {
      // Containers bypassed the Application layer, so none of its actions were
      // ever audited.
      const { service, recordSafe } = build();

      await service.action(TARGET_ID, 'abc123def456', operation);

      expect(recordSafe).toHaveBeenCalledWith(
        expect.objectContaining({ type: `container.${operation}` }),
      );
    },
  );

  it('does not record an action that failed', async () => {
    const { service, recordSafe } = build({
      action: vi.fn().mockResolvedValue(err(new DeploymentError('no such container'))),
    });

    await service.action(TARGET_ID, 'abc123def456', 'stop');

    expect(recordSafe).not.toHaveBeenCalled();
  });

  it.each(['bad id', 'a;reboot', '$(id)', '../x'])('rejects %s as a container id', async (id) => {
    const { service, action } = build();

    expect((await service.action(TARGET_ID, id, 'stop')).ok).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('clamps a log line count to a sane range', async () => {
    const { service, logs } = build();

    await service.logs(TARGET_ID, 'abc123def456', 10_000_000);
    expect(logs).toHaveBeenLastCalledWith(target, 'abc123def456', 5000);

    await service.logs(TARGET_ID, 'abc123def456', -5);
    expect(logs).toHaveBeenLastCalledWith(target, 'abc123def456', 1);
  });

  it.each([
    ['Upper', 'has uppercase'],
    ['has space', 'has a space'],
    ['-leading', 'starts with a dash'],
    ['a/b', 'contains a slash'],
  ])('rejects Compose project %s because it %s', async (projectName) => {
    const { service, deployCompose } = build();

    expect((await service.deployCompose(TARGET_ID, projectName, 'services: {}')).ok).toBe(false);
    expect(deployCompose).not.toHaveBeenCalled();
  });

  it('rejects empty and oversized Compose input', async () => {
    const { service } = build();

    expect((await service.deployCompose(TARGET_ID, 'shop', '   ')).ok).toBe(false);
    expect((await service.deployCompose(TARGET_ID, 'shop', 'x'.repeat(512_001))).ok).toBe(false);
  });

  it('records a Compose deployment without echoing its content', async () => {
    const { service, recordSafe } = build();

    await service.deployCompose(TARGET_ID, 'shop', 'services:\n  api:\n    image: node');

    const [entry] = recordSafe.mock.calls[0] as [{ metadata: Record<string, unknown> }];
    expect(entry.metadata).toEqual({ targetId: TARGET_ID, projectName: 'shop' });
    expect(JSON.stringify(entry)).not.toContain('image: node');
  });

  it('inspects a runtime through the resolved target', async () => {
    const { service, inspect } = build();

    expect((await service.inspect(TARGET_ID)).ok).toBe(true);
    expect(inspect).toHaveBeenCalledWith(target, TARGET_ID);
  });

  it('rejects an invalid target id before inspecting', async () => {
    const { service, inspect } = build();

    expect((await service.inspect('nope')).ok).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });
});
