import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type {
  DeploymentRecord,
  DeploymentRepository,
  DeploymentStatus,
  DeploymentUpdate,
  ProjectContext,
} from '@cloudforge/core';
import type { Deployment as PrismaDeployment } from '@prisma/client';
import type { Db } from '../client.js';

/** Prisma/SQLite implementation of the {@link DeploymentRepository} port. */
export class PrismaDeploymentRepository implements DeploymentRepository {
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
  ) {}

  async create(record: DeploymentRecord): Promise<Result<void, PersistenceError>> {
    return guard('create deployment', async () => {
      const projectId = this.projectId();
      if (record.projectId !== projectId) {
        throw new PersistenceError('Deployment belongs to another project');
      }
      await this.db.deployment.create({
        data: {
          id: record.id,
          projectId,
          status: record.status,
          strategy: record.strategy,
          outputs: record.outputs,
          startedAt: record.startedAt ? new Date(record.startedAt) : null,
          finishedAt: record.finishedAt ? new Date(record.finishedAt) : null,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
        },
      });
    });
  }

  async update(id: string, patch: DeploymentUpdate): Promise<Result<void, PersistenceError>> {
    return guard('update deployment', async () => {
      await this.db.deployment.updateMany({
        where: { id, projectId: this.projectId() },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.outputs !== undefined ? { outputs: patch.outputs } : {}),
          ...(patch.startedAt !== undefined
            ? { startedAt: patch.startedAt ? new Date(patch.startedAt) : null }
            : {}),
          ...(patch.finishedAt !== undefined
            ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null }
            : {}),
        },
      });
    });
  }

  async listByProject(projectId: string): Promise<Result<DeploymentRecord[], PersistenceError>> {
    return guard('list deployments', async () => {
      if (projectId !== this.projectId()) {
        throw new PersistenceError('Cannot list deployments from another project');
      }
      const rows = await this.db.deployment.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toRecord);
    });
  }

  async countAll(): Promise<Result<number, PersistenceError>> {
    return guard('count deployments', () =>
      this.db.deployment.count({ where: { projectId: this.projectId() } }),
    );
  }

  async failRunning(reason: string, finishedAt: string): Promise<Result<number, PersistenceError>> {
    return guard('recover interrupted deployments', async () => {
      const result = await this.db.deployment.updateMany({
        where: { projectId: this.projectId(), status: 'running' },
        data: {
          status: 'failed',
          outputs: JSON.stringify({ error: reason, interrupted: true }),
          finishedAt: new Date(finishedAt),
        },
      });
      return result.count;
    });
  }

  private projectId(): string {
    return this.context.requireActive().projectId;
  }
}

function toRecord(row: PrismaDeployment): DeploymentRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as DeploymentStatus,
    strategy: row.strategy,
    outputs: row.outputs,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
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
