import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { Project, ProjectId, ProjectRepository } from '@cloudforge/core';
import type { Db } from '../client.js';
import { toDomainProject, toPrismaProject } from '../mappers/project-mapper.js';

/** Prisma/SQLite implementation of the {@link ProjectRepository} port. */
export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly db: Db) {}

  async findAll(): Promise<Result<Project[], PersistenceError>> {
    return guard('list projects', async () => {
      const rows = await this.db.project.findMany({ orderBy: { updatedAt: 'desc' } });
      return rows.map(toDomainProject);
    });
  }

  async findById(id: ProjectId): Promise<Result<Project | null, PersistenceError>> {
    return guard('load project', async () => {
      const row = await this.db.project.findUnique({ where: { id } });
      return row ? toDomainProject(row) : null;
    });
  }

  async save(project: Project): Promise<Result<void, PersistenceError>> {
    return guard('save project', async () => {
      const data = toPrismaProject(project);
      await this.db.project.upsert({ where: { id: data.id }, create: data, update: data });
    });
  }

  async delete(id: ProjectId): Promise<Result<void, PersistenceError>> {
    return guard('delete project', async () => {
      await this.db.project.deleteMany({ where: { id } });
    });
  }

  async count(): Promise<Result<number, PersistenceError>> {
    return guard('count projects', () => this.db.project.count());
  }
}

/** Run a Prisma operation, normalising any failure into a {@link PersistenceError}. */
async function guard<T>(
  action: string,
  fn: () => Promise<T>,
): Promise<Result<T, PersistenceError>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(new PersistenceError(`Failed to ${action}`, { cause }));
  }
}
