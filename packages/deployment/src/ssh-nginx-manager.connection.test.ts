import type { DeploymentTarget } from '@cloudforge/core';
import { ok } from '@cloudforge/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SshTransport from './ssh-transport.js';

const withSshConnection = vi.hoisted(() => vi.fn());

vi.mock('./ssh-transport.js', async () => {
  const actual = await vi.importActual<typeof SshTransport>('./ssh-transport.js');
  return { ...actual, withSshConnection };
});

import { runPrivilegedRemote } from './ssh-nginx-manager.js';

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'test-private-key',
  hostKeySha256: 'SHA256:test-host-key',
};

describe('Nginx SSH connection policy', () => {
  beforeEach(() => {
    withSshConnection.mockReset();
    withSshConnection.mockResolvedValue(ok({ stdout: '', stderr: '', exitCode: 0 }));
  });

  it('retries transient handshakes for Nginx and certificate operations', async () => {
    const result = await runPrivilegedRemote(target, 'true');

    expect(result.ok).toBe(true);
    expect(withSshConnection).toHaveBeenCalledOnce();
    expect(withSshConnection.mock.calls[0]?.[1]).toMatchObject({
      label: 'Nginx',
      connectionAttempts: 3,
    });
  });
});
