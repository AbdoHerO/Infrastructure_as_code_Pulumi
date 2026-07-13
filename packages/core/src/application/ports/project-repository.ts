import type { Result } from '@cloudforge/shared';
import type { PersistenceError } from '@cloudforge/shared';
import type { Project, ProjectId } from '../../domain/project/project.js';

/**
 * Persistence port for the {@link Project} aggregate. The Application layer
 * depends on this abstraction; the Infrastructure layer (Prisma) implements it.
 * This inversion keeps the domain free of any storage concern.
 */
export interface ProjectRepository {
  /** Return every project, most recently updated first. */
  findAll(): Promise<Result<Project[], PersistenceError>>;

  /** Return a project by id, or `null` if it does not exist. */
  findById(id: ProjectId): Promise<Result<Project | null, PersistenceError>>;

  /** Insert or update a project. */
  save(project: Project): Promise<Result<void, PersistenceError>>;

  /** Delete a project by id. Deleting a missing project is not an error. */
  delete(id: ProjectId): Promise<Result<void, PersistenceError>>;

  /** Total number of projects. */
  count(): Promise<Result<number, PersistenceError>>;
}
