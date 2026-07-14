import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { InfrastructurePlan } from '../infrastructure/infrastructure-plan.js';
import { ManagedVpsTargetSyncService } from './managed-vps-target-sync-service.js';

const plan: InfrastructurePlan = {
  providerKind: 'oracle',
  config: {},
  resources: [
    {
      kind: 'compute',
      name: 'server',
      shape: 'VM.Standard.A1.Flex',
      image: 'ubuntu-24.04',
      subnetName: 'subnet',
      sshPublicKey: 'ssh-ed25519 AAAATEST cloudforge',
      assignPublicIp: true,
    },
  ],
};

describe('ManagedVpsTargetSyncService', () => {
  it('resolves the encrypted key and synchronizes a provider output', async () => {
    const upsertManaged = vi.fn().mockImplementation((input) =>
      Promise.resolve(
        ok({
          id: 'target-id',
          ...input,
          lastPreflight: null,
          lastPreflightAt: null,
          createdAt: '2026-07-14T00:00:00.000Z',
          updatedAt: '2026-07-14T00:00:00.000Z',
        }),
      ),
    );
    const service = new ManagedVpsTargetSyncService(
      {
        upsertManaged,
        removeManagedProject: vi.fn().mockResolvedValue(ok(undefined)),
        removeManagedResource: vi.fn().mockResolvedValue(ok(undefined)),
      },
      {
        findByPublicKey: vi.fn().mockResolvedValue(
          ok({
            id: 'credential-id',
            name: 'server-key',
            algorithm: 'ed25519',
            publicKey: 'ssh-ed25519 AAAATEST cloudforge',
            fingerprint: 'SHA256:test',
            createdAt: '2026-07-14T00:00:00.000Z',
          }),
        ),
      },
      { inspectHostKey: vi.fn().mockResolvedValue(ok(`SHA256:${'A'.repeat(43)}`)) },
      { attempts: 1, delayMs: 0 },
    );

    const result = await service.sync('project-id', plan, {
      serverPublicIp: '203.0.113.10',
      serverSshUser: 'ubuntu',
    });

    expect(result.warnings).toEqual([]);
    expect(result.targets).toHaveLength(1);
    expect(upsertManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '203.0.113.10',
        username: 'ubuntu',
        sshCredentialId: 'credential-id',
        managedProjectId: 'project-id',
        managedResourceName: 'server',
      }),
    );
  });

  it('removes a stale managed target when its SSH key is no longer valid', async () => {
    const removeManagedResource = vi.fn().mockResolvedValue(ok(undefined));
    const service = new ManagedVpsTargetSyncService(
      {
        upsertManaged: vi.fn(),
        removeManagedProject: vi.fn().mockResolvedValue(ok(undefined)),
        removeManagedResource,
      },
      { findByPublicKey: vi.fn().mockResolvedValue(ok(null)) },
      { inspectHostKey: vi.fn() },
      { attempts: 1, delayMs: 0 },
    );

    const result = await service.sync('project-id', plan, {
      serverPublicIp: '203.0.113.10',
      serverSshUser: 'ubuntu',
    });

    expect(result.targets).toEqual([]);
    expect(result.warnings[0]).toContain('SSH public key is not managed');
    expect(removeManagedResource).toHaveBeenCalledWith('project-id', 'server');
  });
});
