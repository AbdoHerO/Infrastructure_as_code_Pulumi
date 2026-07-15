import { beforeEach, describe, expect, it } from 'vitest';
import { ok, type PersistenceError, type Result } from '@cloudforge/shared';
import type {
  VpsTargetRecord,
  VpsTargetRepository,
  VpsTargetUpdate,
} from '../ports/vps-target-repository.js';
import { VpsTargetService } from './vps-target-service.js';

class MemoryTargets implements VpsTargetRepository {
  readonly values = new Map<string, VpsTargetRecord>();
  list(): Promise<Result<VpsTargetRecord[], PersistenceError>> {
    return Promise.resolve(ok([...this.values.values()]));
  }
  get(id: string): Promise<Result<VpsTargetRecord | null, PersistenceError>> {
    return Promise.resolve(ok(this.values.get(id) ?? null));
  }
  findManaged(
    projectId: string,
    resourceName: string,
  ): Promise<Result<VpsTargetRecord | null, PersistenceError>> {
    return Promise.resolve(
      ok(
        [...this.values.values()].find(
          (value) =>
            value.managedProjectId === projectId && value.managedResourceName === resourceName,
        ) ?? null,
      ),
    );
  }
  create(record: VpsTargetRecord): Promise<Result<void, PersistenceError>> {
    this.values.set(record.id, record);
    return Promise.resolve(ok(undefined));
  }
  update(id: string, patch: VpsTargetUpdate): Promise<Result<void, PersistenceError>> {
    const current = this.values.get(id);
    if (current) this.values.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
    return Promise.resolve(ok(undefined));
  }
  remove(id: string): Promise<Result<void, PersistenceError>> {
    this.values.delete(id);
    return Promise.resolve(ok(undefined));
  }
  removeManaged(projectId: string, resourceName: string): Promise<Result<void, PersistenceError>> {
    for (const [id, value] of this.values) {
      if (value.managedProjectId === projectId && value.managedResourceName === resourceName) {
        this.values.delete(id);
      }
    }
    return Promise.resolve(ok(undefined));
  }
  removeManagedByProject(projectId: string): Promise<Result<void, PersistenceError>> {
    for (const [id, value] of this.values) {
      if (value.managedProjectId === projectId) this.values.delete(id);
    }
    return Promise.resolve(ok(undefined));
  }
  removeManagedResourcesOutside(
    projectId: string,
    resourceNames: readonly string[],
  ): Promise<Result<void, PersistenceError>> {
    for (const [id, value] of this.values) {
      if (
        value.managedProjectId === projectId &&
        (!value.managedResourceName || !resourceNames.includes(value.managedResourceName))
      ) {
        this.values.delete(id);
      }
    }
    return Promise.resolve(ok(undefined));
  }
  removeManagedOutsideProjects(
    projectIds: readonly string[],
  ): Promise<Result<void, PersistenceError>> {
    for (const [id, value] of this.values) {
      if (value.managedProjectId && !projectIds.includes(value.managedProjectId)) {
        this.values.delete(id);
      }
    }
    return Promise.resolve(ok(undefined));
  }
}

const valid = {
  name: 'Production ARM VPS',
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  sshCredentialId: 'credential-id',
  hostKeySha256: `SHA256:${'A'.repeat(43)}`,
};

describe('VpsTargetService', () => {
  let repository: MemoryTargets;
  let service: VpsTargetService;

  beforeEach(() => {
    repository = new MemoryTargets();
    service = new VpsTargetService(repository);
  });

  it('persists and parses the latest preflight report', async () => {
    const created = await service.create(valid);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await service.recordPreflight(created.value.id, { status: 'ready' });
    const listed = await service.list();
    expect(listed.ok && listed.value[0]?.lastPreflight).toEqual({ status: 'ready' });
  });

  it('clears stale readiness when connection identity changes', async () => {
    const created = await service.create(valid);
    if (!created.ok) return;
    await service.recordPreflight(created.value.id, { status: 'ready' });
    const updated = await service.update(created.value.id, { ...valid, host: 'vps.example.com' });
    expect(updated.ok && updated.value.lastPreflight).toBeNull();
  });

  it('rejects unsafe or incomplete targets', async () => {
    const result = await service.create({ ...valid, port: 0, hostKeySha256: 'unknown' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('removes only the saved record', async () => {
    const created = await service.create(valid);
    if (!created.ok) return;
    expect((await service.remove(created.value.id)).ok).toBe(true);
    const listed = await service.list();
    expect(listed.ok && listed.value).toHaveLength(0);
  });

  it('upserts one managed target and removes it with its infrastructure project', async () => {
    const first = await service.upsertManaged({
      ...valid,
      managedProjectId: 'project-1',
      managedResourceName: 'server',
    });
    expect(first.ok).toBe(true);
    const second = await service.upsertManaged({
      ...valid,
      host: '203.0.113.11',
      managedProjectId: 'project-1',
      managedResourceName: 'server',
    });
    expect(second.ok && second.value.id).toBe(first.ok ? first.value.id : '');
    expect(repository.values.size).toBe(1);
    await service.removeManagedProject('project-1');
    expect(repository.values.size).toBe(0);
  });

  it('removes orphaned generated targets but preserves manual targets', async () => {
    const managed = await service.upsertManaged({
      ...valid,
      managedProjectId: 'deleted-project',
      managedResourceName: 'server',
    });
    const manual = await service.create({ ...valid, name: 'External VPS' });
    expect(managed.ok && manual.ok).toBe(true);

    await service.removeManagedOutsideProjects(['active-project']);

    const listed = await service.list();
    expect(listed.ok && listed.value.map((target) => target.name)).toEqual(['External VPS']);
  });
});
