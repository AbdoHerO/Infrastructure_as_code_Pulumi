import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type {
  ProjectContext,
  VpsTargetRecord,
  VpsTargetRepository,
  VpsTargetUpdate,
} from '@cloudforge/core';
import type { VpsTarget as PrismaVpsTarget } from '@prisma/client';
import type { Db } from '../client.js';

export class PrismaVpsTargetRepository implements VpsTargetRepository {
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
  ) {}

  async list(): Promise<Result<VpsTargetRecord[], PersistenceError>> {
    return guard('list VPS targets', async () => {
      const rows = await this.db.vpsTarget.findMany({
        where: { projectId: this.projectId() },
        orderBy: { updatedAt: 'desc' },
      });
      return rows.map(toRecord);
    });
  }

  async get(id: string): Promise<Result<VpsTargetRecord | null, PersistenceError>> {
    return guard('load VPS target', async () => {
      const row = await this.db.vpsTarget.findFirst({
        where: { id, projectId: this.projectId() },
      });
      return row ? toRecord(row) : null;
    });
  }

  async findManaged(
    projectId: string,
    resourceName: string,
  ): Promise<Result<VpsTargetRecord | null, PersistenceError>> {
    return guard('load managed VPS target', async () => {
      const row = await this.db.vpsTarget.findFirst({
        where: {
          projectId: this.projectId(),
          managedProjectId: projectId,
          managedResourceName: resourceName,
        },
      });
      return row ? toRecord(row) : null;
    });
  }

  async create(record: VpsTargetRecord): Promise<Result<void, PersistenceError>> {
    return guard('create VPS target', async () => {
      await this.db.vpsTarget.create({
        data: {
          ...record,
          projectId: this.projectId(),
          lastPreflightAt: record.lastPreflightAt ? new Date(record.lastPreflightAt) : null,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
        },
      });
    });
  }

  async update(id: string, patch: VpsTargetUpdate): Promise<Result<void, PersistenceError>> {
    return guard('update VPS target', async () => {
      await this.db.vpsTarget.updateMany({
        where: { id, projectId: this.projectId() },
        data: {
          ...patch,
          ...(patch.lastPreflightAt !== undefined
            ? { lastPreflightAt: patch.lastPreflightAt ? new Date(patch.lastPreflightAt) : null }
            : {}),
        },
      });
    });
  }

  async remove(id: string): Promise<Result<void, PersistenceError>> {
    return guard('delete VPS target', async () => {
      await this.db.vpsTarget.deleteMany({ where: { id, projectId: this.projectId() } });
    });
  }

  async removeManaged(
    projectId: string,
    resourceName: string,
  ): Promise<Result<void, PersistenceError>> {
    return guard('delete managed VPS target', async () => {
      await this.db.vpsTarget.deleteMany({
        where: {
          projectId: this.projectId(),
          managedProjectId: projectId,
          managedResourceName: resourceName,
        },
      });
    });
  }

  async removeManagedByProject(projectId: string): Promise<Result<void, PersistenceError>> {
    return guard('delete managed VPS targets', async () => {
      await this.db.vpsTarget.deleteMany({
        where: { projectId: this.projectId(), managedProjectId: projectId },
      });
    });
  }

  async removeManagedResourcesOutside(
    projectId: string,
    resourceNames: readonly string[],
  ): Promise<Result<void, PersistenceError>> {
    return guard('delete stale managed VPS targets', async () => {
      await this.db.vpsTarget.deleteMany({
        where: {
          projectId: this.projectId(),
          managedProjectId: projectId,
          ...(resourceNames.length > 0
            ? { managedResourceName: { notIn: [...resourceNames] } }
            : {}),
        },
      });
    });
  }

  async removeManagedOutsideProjects(
    projectIds: readonly string[],
  ): Promise<Result<void, PersistenceError>> {
    return guard('delete orphaned managed VPS targets', async () => {
      await this.db.vpsTarget.deleteMany({
        where: {
          projectId: this.projectId(),
          managedProjectId:
            projectIds.length > 0 ? { not: null, notIn: [...projectIds] } : { not: null },
        },
      });
    });
  }

  private projectId(): string {
    return this.context.requireActive().projectId;
  }
}

function toRecord(row: PrismaVpsTarget): VpsTargetRecord {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    sshCredentialId: row.sshCredentialId,
    hostKeySha256: row.hostKeySha256,
    lastPreflight: row.lastPreflight,
    lastPreflightAt: row.lastPreflightAt?.toISOString() ?? null,
    managedProjectId: row.managedProjectId,
    managedResourceName: row.managedResourceName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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
