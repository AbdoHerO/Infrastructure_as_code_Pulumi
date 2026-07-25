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
  readonly icon: string;
  readonly color: string;
  readonly hasPasskey: boolean;
  readonly lastOpenedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Deliberately small representation exposed before a workspace is unlocked.
 * Configuration, provider links, variables, notes and tags are excluded from
 * the locked project-picker boundary.
 */
export interface ProjectPickerDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly environment: Environment;
  readonly region: string;
  readonly status: ProjectStatus;
  readonly icon: string;
  readonly color: string;
  readonly hasPasskey: boolean;
  readonly lastOpenedAt: string | null;
  readonly createdAt: string;
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
    icon: snapshot.icon,
    color: snapshot.color,
    hasPasskey: snapshot.passkeyHash !== null,
    lastOpenedAt: snapshot.lastOpenedAt,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

/** Map a project to the metadata that may be shown while it is locked. */
export function toProjectPickerDto(project: Project): ProjectPickerDto {
  const snapshot = project.toSnapshot();
  return {
    id: snapshot.id,
    name: snapshot.name,
    description: snapshot.description,
    environment: snapshot.environment,
    region: snapshot.region,
    status: snapshot.status,
    icon: snapshot.icon,
    color: snapshot.color,
    hasPasskey: snapshot.passkeyHash !== null,
    lastOpenedAt: snapshot.lastOpenedAt,
    createdAt: snapshot.createdAt,
  };
}
