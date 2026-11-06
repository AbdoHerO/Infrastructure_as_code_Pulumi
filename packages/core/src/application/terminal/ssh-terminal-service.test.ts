import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type { SshTerminalManager } from '../ports/ssh-terminal-manager.js';
import { SshTerminalService } from './ssh-terminal-service.js';

const TARGET_ID = '11111111-1111-4111-8111-111111111111';

function fixture(): {
  service: SshTerminalService;
  exec: ReturnType<typeof vi.fn>;
  recordSafe: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn(() =>
    Promise.resolve(
      ok({ exitCode: 0, stdout: 'hello', stderr: '', truncated: false, timedOut: false }),
    ),
  );
  const recordSafe = vi.fn();
  const service = new SshTerminalService(
    {
      resolve: () => Promise.resolve(ok({ host: '203.0.113.1' })),
    } as unknown as RemoteTargetResolver,
    { exec } as unknown as SshTerminalManager,
    { recordSafe } as unknown as ActivityService,
  );
  return { service, exec, recordSafe };
}

describe('SshTerminalService.exec', () => {
  it('runs the command on the saved target and returns its output', async () => {
    const { service, exec } = fixture();
    const result = await service.exec(TARGET_ID, 'uptime', 30);
    expect(result.ok && result.value.stdout).toBe('hello');
    expect(exec).toHaveBeenCalledWith(
      { host: '203.0.113.1' },
      'uptime',
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it('records that a command ran, never the command itself', async () => {
    const { service, recordSafe } = fixture();
    await service.exec(TARGET_ID, 'echo top-secret-value');
    expect(recordSafe).toHaveBeenCalledOnce();
    expect(JSON.stringify(recordSafe.mock.calls)).not.toContain('top-secret-value');
  });

  it.each([
    ['not-a-uuid', 'uptime', 60],
    [TARGET_ID, '   ', 60],
    [TARGET_ID, 'x'.repeat(65_537), 60],
    [TARGET_ID, 'uptime', 0],
    [TARGET_ID, 'uptime', 601],
    [TARGET_ID, 'uptime', 1.5],
  ])('refuses a bad request %#', async (targetId, command, timeout) => {
    const { service, exec } = fixture();
    const result = await service.exec(targetId, command, timeout);
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
