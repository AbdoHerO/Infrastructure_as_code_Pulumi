import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { HostFirewallState } from '../ports/host-firewall.js';
import {
  hostFirewallAllows,
  HostFirewallService,
  MAX_HOST_FIREWALL_PORTS,
  validateHostFirewallPorts,
} from './host-firewall-service.js';

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:test',
};

const state = (rules: HostFirewallState['rules']): HostFirewallState => ({
  backend: 'iptables',
  active: true,
  indeterminate: false,
  rules,
});

function setup() {
  const open = vi
    .fn()
    .mockResolvedValue(ok(state([{ port: 443, protocol: 'tcp', managed: true, raw: 'tcp 443' }])));
  const close = vi.fn().mockResolvedValue(ok(state([])));
  const inspect = vi.fn().mockResolvedValue(ok(state([])));
  const recordSafe = vi.fn();
  const resolve = vi.fn().mockResolvedValue(ok(target));
  const service = new HostFirewallService({ resolve }, { inspect, open, close }, {
    recordSafe,
  } as unknown as ActivityService);
  return { service, open, close, inspect, recordSafe, resolve };
}

describe('HostFirewallService', () => {
  it('opens exactly the ports named, on the saved target, and records it', async () => {
    const { service, open, recordSafe, resolve } = setup();
    const result = await service.open('target-1', [{ port: 443, protocol: 'tcp' }]);

    expect(result.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith('target-1');
    expect(open).toHaveBeenCalledWith(target, [{ port: 443, protocol: 'tcp' }]);
    expect(recordSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'host.firewall.opened',
        metadata: { targetId: 'target-1', ports: ['443/tcp'], backend: 'iptables' },
      }),
    );
  });

  it('refuses invalid ports before connecting to anything', async () => {
    const { service, open, resolve } = setup();
    for (const ports of [
      [],
      [{ port: 0, protocol: 'tcp' as const }],
      [{ port: 70_000, protocol: 'tcp' as const }],
      [{ port: 44.3, protocol: 'tcp' as const }],
      [{ port: 443, protocol: 'icmp' as never }],
    ]) {
      expect((await service.open('target-1', ports)).ok).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never closes the SSH port CloudForge is connected through', async () => {
    const { service, close } = setup();
    const result = await service.close('target-1', [
      { port: 443, protocol: 'tcp' },
      { port: 22, protocol: 'tcp' },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('lock CloudForge out');
    expect(close).not.toHaveBeenCalled();
  });

  it('closes a port that is not SSH and records it', async () => {
    const { service, close, recordSafe } = setup();
    const result = await service.close('target-1', [{ port: 443, protocol: 'tcp' }]);

    expect(result.ok).toBe(true);
    expect(close).toHaveBeenCalledWith(target, [{ port: 443, protocol: 'tcp' }]);
    expect(recordSafe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'host.firewall.closed' }),
    );
  });

  it('requires a saved target', async () => {
    const { service, inspect } = setup();
    expect((await service.inspect('  ')).ok).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe('validateHostFirewallPorts', () => {
  it('drops repeats and caps the number of ports', () => {
    const repeated = validateHostFirewallPorts([
      { port: 443, protocol: 'tcp' },
      { port: 443, protocol: 'tcp' },
      { port: 443, protocol: 'udp' },
    ]);
    expect(repeated.ok && repeated.value).toEqual([
      { port: 443, protocol: 'tcp' },
      { port: 443, protocol: 'udp' },
    ]);
    const many = Array.from({ length: MAX_HOST_FIREWALL_PORTS + 1 }, (_, i) => ({
      port: 8000 + i,
      protocol: 'tcp' as const,
    }));
    expect(validateHostFirewallPorts(many).ok).toBe(false);
  });
});

describe('hostFirewallAllows', () => {
  it('reads a filtering firewall rule by rule', () => {
    const filtering = state([{ port: 80, protocol: 'tcp', managed: true, raw: '' }]);
    expect(hostFirewallAllows(filtering, 80, 'tcp')).toBe(true);
    expect(hostFirewallAllows(filtering, 443, 'tcp')).toBe(false);
  });

  it('treats an inactive or absent firewall as allowing, and an unread one as unknown', () => {
    expect(hostFirewallAllows({ ...state([]), backend: 'none' }, 443, 'tcp')).toBe(true);
    expect(hostFirewallAllows({ ...state([]), active: false }, 443, 'tcp')).toBe(true);
    expect(hostFirewallAllows({ ...state([]), indeterminate: true }, 443, 'tcp')).toBeNull();
    expect(hostFirewallAllows({ ...state([]), backend: 'unknown' }, 443, 'tcp')).toBeNull();
  });
});
