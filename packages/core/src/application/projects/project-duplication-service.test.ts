import { describe, expect, it, vi } from 'vitest';
import { ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { Project, ProjectId, ProjectPasskey } from '../../domain/project/project.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { ProjectConfigurationCloner } from '../ports/project-configuration-cloner.js';
import type { ProjectPasskeyHasher } from '../ports/project-passkey-hasher.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { ProjectDuplicationService } from './project-duplication-service.js';
import { ProjectService } from './project-service.js';

class InMemoryProjectRepository implements ProjectRepository {
  readonly store = new Map<string, Project>();
  findAll(): Promise<Result<Project[], PersistenceError>> {
    return Promise.resolve(ok([...this.store.values()]));
  }
  findById(id: ProjectId): Promise<Result<Project | null, PersistenceError>> {
    return Promise.resolve(ok(this.store.get(id) ?? null));
  }
  save(project: Project): Promise<Result<void, PersistenceError>> {
    this.store.set(project.id, project);
    return Promise.resolve(ok(undefined));
  }
  delete(id: ProjectId): Promise<Result<void, PersistenceError>> {
    this.store.delete(id);
    return Promise.resolve(ok(undefined));
  }
  count(): Promise<Result<number, PersistenceError>> {
    return Promise.resolve(ok(this.store.size));
  }
}

const passkeys: ProjectPasskeyHasher = {
  hash: () => Promise.resolve(ok({ hash: 'hash', salt: 'salt', version: 1 })),
  verify: (_raw: string, _stored: ProjectPasskey) => Promise.resolve(ok(true)),
};

describe('ProjectDuplicationService', () => {
  it('creates a locked configuration-only copy and applies remapped links', async () => {
    const repository = new InMemoryProjectRepository();
    const projects = new ProjectService(repository, passkeys);
    const source = await projects.create({
      name: 'Production',
      description: 'Source',
      environment: 'production',
      region: 'af-casablanca-1',
      variables: { SAFE_SETTING: 'copied' },
      icon: '☁️',
      color: '#123456',
    });
    if (!source.ok) throw source.error;
    const clone = vi.fn().mockResolvedValue(
      ok({
        providerId: '11111111-1111-4111-8111-111111111111',
        templateId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    const recordSafe = vi.fn();
    const cloner: ProjectConfigurationCloner = { clone };
    const service = new ProjectDuplicationService(
      projects,
      cloner,
      { recordSafe } as unknown as ActivityService,
    );

    const result = await service.duplicate(source.value.id, {
      name: 'Production Copy',
      passkey: 'new-passkey',
    });

    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      name: 'Production Copy',
      description: 'Source',
      environment: 'production',
      region: 'af-casablanca-1',
      variables: { SAFE_SETTING: 'copied' },
      hasPasskey: true,
      providerId: '11111111-1111-4111-8111-111111111111',
      templateId: '22222222-2222-4222-8222-222222222222',
    });
    expect(clone).toHaveBeenCalledWith(source.value.id, result.value.id);
    expect(recordSafe).toHaveBeenCalledOnce();
    const activity = recordSafe.mock.calls[0]?.[0] as
      | {
          projectId?: string;
          type?: string;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    expect(activity?.projectId).toBe(source.value.id);
    expect(activity?.type).toBe('project.duplicated');
    expect(activity?.metadata?.mode).toBe('configuration-only');
  });

  it('rolls back the new project when configuration cloning fails', async () => {
    const repository = new InMemoryProjectRepository();
    const projects = new ProjectService(repository, passkeys);
    const source = await projects.create({
      name: 'Production',
      environment: 'production',
      region: 'af-casablanca-1',
    });
    if (!source.ok) throw source.error;
    const failure = new PersistenceError('clone failed');
    const service = new ProjectDuplicationService(
      projects,
      {
        clone: () => Promise.resolve({ ok: false, error: failure }),
      },
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await service.duplicate(source.value.id, {
      name: 'Broken Copy',
      passkey: 'new-passkey',
    });

    expect(result).toEqual({ ok: false, error: failure });
    expect(repository.store.size).toBe(1);
    expect([...repository.store.values()][0]?.name).toBe('Production');
  });
});
