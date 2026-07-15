import {
  type Brand,
  err,
  NotFoundError,
  ok,
  parseUuid,
  type PersistenceError,
  type Result,
  type Uuid,
  ValidationError,
} from '@cloudforge/shared';
import {
  type CreateProjectInput,
  Project,
  type ProjectId,
  type UpdateProjectInput,
} from '../../domain/project/project.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import { type ProjectDto, toProjectDto } from '../dto/project-dto.js';

/** Union of every failure the project use-cases can surface. */
export type ProjectServiceError = ValidationError | NotFoundError | PersistenceError;

/**
 * Application service exposing the project use-cases. It orchestrates the
 * {@link Project} aggregate and its {@link ProjectRepository}, returning
 * transport DTOs and typed errors — never leaking domain objects or throwing.
 */
export class ProjectService {
  constructor(private readonly projects: ProjectRepository) {}

  async create(input: CreateProjectInput): Promise<Result<ProjectDto, ProjectServiceError>> {
    const created = Project.create(input);
    if (!created.ok) return created;

    const saved = await this.projects.save(created.value);
    if (!saved.ok) return saved;

    return ok(toProjectDto(created.value));
  }

  async list(): Promise<Result<ProjectDto[], PersistenceError>> {
    const found = await this.projects.findAll();
    if (!found.ok) return found;
    return ok(found.value.map(toProjectDto));
  }

  async get(id: string): Promise<Result<ProjectDto, ProjectServiceError>> {
    const project = await this.load(id);
    if (!project.ok) return project;
    return ok(toProjectDto(project.value));
  }

  async update(
    id: string,
    input: UpdateProjectInput,
  ): Promise<Result<ProjectDto, ProjectServiceError>> {
    const project = await this.load(id);
    if (!project.ok) return project;

    const updated = project.value.update(input);
    if (!updated.ok) return updated;

    const saved = await this.projects.save(updated.value);
    if (!saved.ok) return saved;

    return ok(toProjectDto(updated.value));
  }

  /** Validate and project an update without writing it to persistence. */
  async previewUpdate(
    id: string,
    input: UpdateProjectInput,
  ): Promise<Result<ProjectDto, ProjectServiceError>> {
    const project = await this.load(id);
    if (!project.ok) return project;
    const candidate = Project.reconstitute(project.value.toSnapshot());
    const updated = candidate.update(input);
    return updated.ok ? ok(toProjectDto(updated.value)) : updated;
  }

  async remove(id: string): Promise<Result<void, ProjectServiceError>> {
    const project = await this.load(id);
    if (!project.ok) return project;
    return this.projects.delete(project.value.id);
  }

  async count(): Promise<Result<number, PersistenceError>> {
    return this.projects.count();
  }

  /** Parse an id and load the aggregate, or fail with a typed error. */
  private async load(id: string): Promise<Result<Project, ProjectServiceError>> {
    const projectId = parseProjectId(id);
    if (!projectId.ok) return projectId;

    const found = await this.projects.findById(projectId.value);
    if (!found.ok) return found;
    if (found.value === null) {
      return err(new NotFoundError('Project not found', { context: { id } }));
    }
    return ok(found.value);
  }
}

function parseProjectId(id: string): Result<ProjectId, ValidationError> {
  const uuid = parseUuid(id);
  if (uuid === null) {
    return err(new ValidationError('Invalid project id', { context: { id } }));
  }
  return ok(uuid as Brand<Uuid, 'ProjectId'>);
}
