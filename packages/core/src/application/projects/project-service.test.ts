import { beforeEach, describe, expect, it } from 'vitest';
import { ok, type PersistenceError, type Result } from '@cloudforge/shared';
import type { Project, ProjectId } from '../../domain/project/project.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { ProjectService } from './project-service.js';

/** Minimal in-memory repository used to exercise the service in isolation. */
class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<string, Project>();

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

describe('ProjectService', () => {
  let service: ProjectService;

  beforeEach(() => {
    service = new ProjectService(new InMemoryProjectRepository());
  });

  it('creates then lists a project', async () => {
    const created = await service.create({
      name: 'API',
      environment: 'production',
      region: 'eu-frankfurt-1',
    });
    expect(created.ok).toBe(true);

    const listed = await service.list();
    expect(listed.ok && listed.value).toHaveLength(1);
  });

  it('surfaces validation errors from create', async () => {
    const result = await service.create({ name: '', environment: 'production', region: 'r' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('returns NOT_FOUND for a missing project', async () => {
    const result = await service.get('11111111-1111-4111-8111-111111111111');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns VALIDATION for a malformed id', async () => {
    const result = await service.get('not-a-uuid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('updates and deletes a project', async () => {
    const created = await service.create({
      name: 'API',
      environment: 'staging',
      region: 'eu-frankfurt-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    const updated = await service.update(id, { status: 'active' });
    expect(updated.ok && updated.value.status).toBe('active');

    const removed = await service.remove(id);
    expect(removed.ok).toBe(true);

    const listed = await service.list();
    expect(listed.ok && listed.value).toHaveLength(0);
  });
});
