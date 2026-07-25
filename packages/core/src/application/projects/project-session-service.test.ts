import { describe, expect, it, vi } from 'vitest';
import { ok, type PersistenceError, type Result, UnauthorizedError } from '@cloudforge/shared';
import { Project, type ProjectId, type ProjectPasskey } from '../../domain/project/project.js';
import type { ProjectPasskeyHasher } from '../ports/project-passkey-hasher.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { InMemoryProjectContext } from './project-context.js';
import { ProjectSessionService, type ProjectSessionLifecycle } from './project-session-service.js';

class MemoryProjects implements ProjectRepository {
  readonly values = new Map<string, Project>();

  findAll(): Promise<Result<Project[], PersistenceError>> {
    return Promise.resolve(ok([...this.values.values()]));
  }

  findById(id: ProjectId): Promise<Result<Project | null, PersistenceError>> {
    return Promise.resolve(ok(this.values.get(id) ?? null));
  }

  save(project: Project): Promise<Result<void, PersistenceError>> {
    this.values.set(project.id, project);
    return Promise.resolve(ok(undefined));
  }

  delete(id: ProjectId): Promise<Result<void, PersistenceError>> {
    this.values.delete(id);
    return Promise.resolve(ok(undefined));
  }

  count(): Promise<Result<number, PersistenceError>> {
    return Promise.resolve(ok(this.values.size));
  }
}

const passkeys: ProjectPasskeyHasher = {
  hash: (plaintext) => Promise.resolve(ok({ hash: `hash:${plaintext}`, salt: 'salt', version: 1 })),
  verify: (plaintext, stored) => Promise.resolve(ok(stored.hash === `hash:${plaintext}`)),
};

function makeProject(name: string, passkey?: string): Project {
  const result = Project.create({
    name,
    environment: 'production',
    region: 'eu-frankfurt-1',
  });
  if (!result.ok) throw result.error;
  if (passkey) {
    const protectedPasskey: ProjectPasskey = {
      hash: `hash:${passkey}`,
      salt: 'salt',
      version: 1,
    };
    result.value.setPasskey(protectedPasskey);
  }
  return result.value;
}

describe('ProjectSessionService', () => {
  it('keeps a protected project locked when the passkey is incorrect', async () => {
    const projects = new MemoryProjects();
    const project = makeProject('Protected', 'correct-passkey');
    projects.values.set(project.id, project);
    const context = new InMemoryProjectContext();
    const service = new ProjectSessionService(projects, passkeys, context);

    const result = await service.unlock(project.id, 'wrong-passkey');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(UnauthorizedError);
    expect(context.current()).toBeNull();
  });

  it('unlocks legacy projects without a passkey and records last opened', async () => {
    const projects = new MemoryProjects();
    const project = makeProject('Legacy');
    projects.values.set(project.id, project);
    const context = new InMemoryProjectContext();
    const service = new ProjectSessionService(projects, passkeys, context);

    const result = await service.unlock(project.id, '');

    expect(result.ok).toBe(true);
    expect(context.current()?.projectId).toBe(project.id);
    expect(project.toSnapshot().lastOpenedAt).not.toBeNull();
  });

  it('tears down the previous workspace before activating the next one', async () => {
    const projects = new MemoryProjects();
    const first = makeProject('First');
    const second = makeProject('Second');
    projects.values.set(first.id, first);
    projects.values.set(second.id, second);
    const events: string[] = [];
    const lifecycle: ProjectSessionLifecycle = {
      beforeDeactivate: (lease) => {
        events.push(`close:${lease.projectId}`);
        return Promise.resolve();
      },
      afterActivate: (lease) => {
        events.push(`open:${lease.projectId}`);
        return Promise.resolve();
      },
    };
    const service = new ProjectSessionService(
      projects,
      passkeys,
      new InMemoryProjectContext(),
      lifecycle,
    );

    await service.unlock(first.id, '');
    await service.unlock(second.id, '');

    expect(events).toEqual([`open:${first.id}`, `close:${first.id}`, `open:${second.id}`]);
  });

  it('serializes concurrent project switches', async () => {
    const projects = new MemoryProjects();
    const first = makeProject('First');
    const second = makeProject('Second');
    projects.values.set(first.id, first);
    projects.values.set(second.id, second);
    let releaseClose: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const lifecycle: ProjectSessionLifecycle = {
      beforeDeactivate: () => closeStarted,
      afterActivate: () => Promise.resolve(),
    };
    const context = new InMemoryProjectContext();
    const service = new ProjectSessionService(projects, passkeys, context, lifecycle);
    await service.unlock(first.id, '');

    const switching = service.unlock(second.id, '');
    const locking = service.lock();
    await vi.waitFor(() => expect(context.current()?.projectId).toBe(first.id));
    releaseClose?.();

    await switching;
    await locking;
    expect(context.current()).toBeNull();
  });

  it('keeps the current workspace active when teardown refuses a switch', async () => {
    const projects = new MemoryProjects();
    const first = makeProject('First');
    const second = makeProject('Second');
    projects.values.set(first.id, first);
    projects.values.set(second.id, second);
    const context = new InMemoryProjectContext();
    const service = new ProjectSessionService(projects, passkeys, context, {
      beforeDeactivate: () => Promise.reject(new Error('operation still active')),
      afterActivate: () => Promise.resolve(),
    });
    await service.unlock(first.id, '');

    const switched = await service.unlock(second.id, '');

    expect(switched.ok).toBe(false);
    expect(context.current()?.projectId).toBe(first.id);
  });

  it('changes a passkey only after verifying the current one', async () => {
    const projects = new MemoryProjects();
    const project = makeProject('Protected', 'current-passkey');
    projects.values.set(project.id, project);
    const context = new InMemoryProjectContext();
    const service = new ProjectSessionService(projects, passkeys, context);
    await service.unlock(project.id, 'current-passkey');

    const rejected = await service.changePasskey('wrong-passkey', 'replacement-passkey');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toBeInstanceOf(UnauthorizedError);

    const changed = await service.changePasskey('current-passkey', 'replacement-passkey');
    expect(changed).toEqual({ ok: true, value: undefined });
    expect(project.toSnapshot().passkeyHash).toBe('hash:replacement-passkey');
  });

  it('does not activate a workspace when lifecycle setup fails', async () => {
    const projects = new MemoryProjects();
    const project = makeProject('Broken');
    projects.values.set(project.id, project);
    const context = new InMemoryProjectContext();
    const lifecycle: ProjectSessionLifecycle = {
      beforeDeactivate: () => Promise.resolve(),
      afterActivate: () => Promise.reject(new Error('setup failed')),
    };
    const service = new ProjectSessionService(projects, passkeys, context, lifecycle);

    const result = await service.unlock(project.id, '');

    expect(result.ok).toBe(false);
    expect(context.current()).toBeNull();
  });
});
