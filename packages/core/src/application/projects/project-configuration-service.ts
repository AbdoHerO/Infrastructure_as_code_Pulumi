import {
  ConflictError,
  type InfrastructureError,
  type PersistenceError,
  type Result,
} from '@cloudforge/shared';
import type { UpdateProjectInput } from '../../domain/project/project.js';
import type { ProjectDto } from '../dto/project-dto.js';
import type { StackReference } from '../ports/infrastructure-engine.js';
import type { InfrastructureService } from '../infrastructure/infrastructure-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { ProjectService, ProjectServiceError } from './project-service.js';

export type ProjectConfigurationError =
  ProjectServiceError | PersistenceError | InfrastructureError | ConflictError;

export type ProjectStackReferenceResolver = (project: ProjectDto) => StackReference;

/**
 * Coordinates editable project metadata with its declarative infrastructure.
 * Mutable labels stay safe because fields that identify or relocate a live
 * stack cannot be changed after resources have been provisioned.
 */
export class ProjectConfigurationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly infrastructure: InfrastructureService,
    private readonly stackReference: ProjectStackReferenceResolver,
    private readonly activities: ActivityService,
  ) {}

  async update(
    id: string,
    input: UpdateProjectInput,
  ): Promise<Result<ProjectDto, ProjectConfigurationError>> {
    const current = await this.projects.get(id);
    if (!current.ok) return current;
    const proposed = await this.projects.previewUpdate(id, input);
    if (!proposed.ok) return proposed;

    const identityChanged =
      current.value.name !== proposed.value.name ||
      current.value.environment !== proposed.value.environment;
    const regionChanged = current.value.region !== proposed.value.region;
    const providerChanged = current.value.providerId !== proposed.value.providerId;
    const protectedChange = identityChanged || regionChanged || providerChanged;
    let hasManagedResources = false;

    if (protectedChange) {
      const stacks = await this.infrastructure.listManagedStacks();
      if (!stacks.ok) return stacks;
      const currentRef = this.stackReference(current.value);
      hasManagedResources = stacks.value.some(
        (stack) => stack.ref.project === currentRef.project && stack.ref.stack === currentRef.stack,
      );
      if (hasManagedResources) {
        return {
          ok: false,
          error: new ConflictError(
            'Name, environment, region and cloud provider cannot be changed while this project has managed infrastructure. Destroy the stack first; description and notes remain editable.',
            { context: { projectId: id } },
          ),
        };
      }
    }

    const plan = regionChanged ? await this.infrastructure.getPlan(id) : null;
    if (plan && !plan.ok) return plan;
    if (plan?.ok && plan.value) {
      const savedPlan = await this.infrastructure.savePlan(id, {
        ...plan.value,
        config: { ...plan.value.config, region: proposed.value.region },
      });
      if (!savedPlan.ok) return savedPlan;
    }

    const updated = await this.projects.update(id, input);
    if (!updated.ok) {
      if (plan?.ok && plan.value) await this.infrastructure.savePlan(id, plan.value);
      return updated;
    }
    this.activities.recordSafe({
      type: 'project.updated',
      message: `Updated project "${updated.value.name}"`,
      projectId: id,
      metadata: { identityChanged, regionChanged, providerChanged, hasManagedResources },
    });
    return updated;
  }
}
