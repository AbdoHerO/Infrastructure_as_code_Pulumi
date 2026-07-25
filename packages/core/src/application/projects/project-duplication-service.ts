import type { PersistenceError, Result } from '@cloudforge/shared';
import type { ProjectDto } from '../dto/project-dto.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { ProjectConfigurationCloner } from '../ports/project-configuration-cloner.js';
import type { ProjectService, ProjectServiceError } from './project-service.js';

export interface DuplicateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly passkey: string;
}

export type ProjectDuplicationError = ProjectServiceError | PersistenceError;

/** Creates a safe configuration-only copy of the currently opened project. */
export class ProjectDuplicationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly cloner: ProjectConfigurationCloner,
    private readonly activities: ActivityService,
  ) {}

  async duplicate(
    sourceProjectId: string,
    input: DuplicateProjectInput,
  ): Promise<Result<ProjectDto, ProjectDuplicationError>> {
    const source = await this.projects.get(sourceProjectId);
    if (!source.ok) return source;
    const created = await this.projects.create({
      name: input.name,
      description: input.description ?? source.value.description,
      environment: source.value.environment,
      region: source.value.region,
      tags: source.value.tags,
      variables: source.value.variables,
      notes: source.value.notes,
      icon: source.value.icon,
      color: source.value.color,
      passkey: input.passkey,
    });
    if (!created.ok) return created;

    const cloned = await this.cloner.clone(sourceProjectId, created.value.id);
    if (!cloned.ok) {
      await this.projects.remove(created.value.id);
      return cloned;
    }
    const linked = await this.projects.update(created.value.id, {
      providerId: cloned.value.providerId,
      templateId: cloned.value.templateId,
    });
    if (!linked.ok) {
      await this.projects.remove(created.value.id);
      return linked;
    }
    this.activities.recordSafe({
      projectId: sourceProjectId,
      type: 'project.duplicated',
      message: `Duplicated project "${source.value.name}" as "${linked.value.name}"`,
      metadata: { duplicateProjectId: linked.value.id, mode: 'configuration-only' },
    });
    return linked;
  }
}
