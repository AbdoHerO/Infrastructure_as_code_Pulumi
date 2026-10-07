import { describe, expect, it, vi } from 'vitest';
import { ok, type PersistenceError, type Result } from '@cloudforge/shared';
import type { Project, ProjectId } from '../../domain/project/project.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { InfrastructurePlan } from '../infrastructure/infrastructure-plan.js';
import type { InfrastructureService } from '../infrastructure/infrastructure-service.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { ProjectConfigurationService } from './project-configuration-service.js';
import { ProjectService } from './project-service.js';

class MemoryProjects implements ProjectRepository {
  private readonly values = new Map<string, Project>();
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

const initialPlan: InfrastructurePlan = {
  providerKind: 'oracle',
  config: { region: 'af-casablanca-1' },
  resources: [],
};

/** One deployed resource, so a stack that carries it is genuinely managed. */
const MANAGED_STACK = {
  ref: { project: 'store-stack', stack: 'development' },
  resources: [{ name: 'server', type: 'oci:Core/instance:Instance', provider: 'oracle' }],
};

async function fixture(hasManagedResources: boolean): Promise<{
  projectId: string;
  subject: ProjectConfigurationService;
  savedPlans: InfrastructurePlan[];
}> {
  // A resource, not an empty list: the guard is about deployed infrastructure,
  // and a fixture whose "managed" stack held nothing described the bug rather
  // than the rule.
  return fixtureWithStacks(hasManagedResources ? [MANAGED_STACK] : []);
}

async function fixtureWithStacks(stacks: readonly unknown[]): Promise<{
  projectId: string;
  subject: ProjectConfigurationService;
  savedPlans: InfrastructurePlan[];
}> {
  const projects = new ProjectService(new MemoryProjects());
  const created = await projects.create({
    name: 'Store',
    environment: 'development',
    region: 'af-casablanca-1',
  });
  if (!created.ok) throw created.error;
  const savedPlans: InfrastructurePlan[] = [];
  const infrastructure = {
    listManagedStacks: vi.fn().mockResolvedValue(ok(stacks)),
    getPlan: vi.fn().mockResolvedValue(ok(initialPlan)),
    savePlan: vi.fn().mockImplementation((_id: string, plan: InfrastructurePlan) => {
      savedPlans.push(plan);
      return Promise.resolve(ok(undefined));
    }),
  } as unknown as InfrastructureService;
  const activities = { recordSafe: vi.fn() } as unknown as ActivityService;
  return {
    projectId: created.value.id,
    savedPlans,
    subject: new ProjectConfigurationService(
      projects,
      infrastructure,
      () => ({ project: 'store-stack', stack: 'development' }),
      activities,
    ),
  };
}

describe('ProjectConfigurationService', () => {
  it('updates an unprovisioned project and synchronizes its saved plan region', async () => {
    const { projectId, subject, savedPlans } = await fixture(false);
    const result = await subject.update(projectId, {
      name: 'Store API',
      region: 'eu-frankfurt-1',
    });
    expect(result.ok && result.value.name).toBe('Store API');
    expect(result.ok && result.value.region).toBe('eu-frankfurt-1');
    expect(savedPlans.at(-1)?.config.region).toBe('eu-frankfurt-1');
  });

  it('blocks stack identity and region changes once resources are managed', async () => {
    const { projectId, subject } = await fixture(true);
    const result = await subject.update(projectId, { region: 'eu-frankfurt-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
  });

  it('permits identity changes when the stack exists but holds no resources', async () => {
    /*
     * A destroy empties the checkpoint and leaves it on disk, and a preview
     * that was never applied writes one holding nothing. Treating either as
     * managed infrastructure locked the project's name, region and provider
     * and told the user to destroy a stack they had already destroyed — a
     * dead end with no way to comply.
     */
    const { projectId, subject } = await fixtureWithStacks([
      { ref: { project: 'store-stack', stack: 'development' }, resources: [] },
    ]);
    const result = await subject.update(projectId, { region: 'eu-frankfurt-1' });
    expect(result.ok).toBe(true);
  });

  it('still permits descriptive edits on a provisioned project', async () => {
    const { projectId, subject } = await fixture(true);
    const result = await subject.update(projectId, { description: 'Production storefront' });
    expect(result.ok && result.value.description).toBe('Production storefront');
  });
});
