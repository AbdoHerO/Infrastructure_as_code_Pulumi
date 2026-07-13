import type { Environment } from '../../domain/project/environment.js';
import type { Project } from '../../domain/project/project.js';
import type { ProjectStatus } from '../../domain/project/project-status.js';

/**
 * Serializable, transport-safe representation of a project. This is the shape
 * that crosses the IPC boundary and reaches the renderer — plain primitives only.
 */
export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly environment: Environment;
  readonly region: string;
  readonly providerId: string | null;
  readonly templateId: string | null;
  readonly status: ProjectStatus;
  readonly tags: readonly string[];
  readonly variables: Readonly<Record<string, string>>;
  readonly notes: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Map a domain {@link Project} to its transport DTO. */
export function toProjectDto(project: Project): ProjectDto {
  const snapshot = project.toSnapshot();
  return {
    id: snapshot.id,
    name: snapshot.name,
    description: snapshot.description,
    environment: snapshot.environment,
    region: snapshot.region,
    providerId: snapshot.providerId,
    templateId: snapshot.templateId,
    status: snapshot.status,
    tags: snapshot.tags,
    variables: snapshot.variables,
    notes: snapshot.notes,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}
