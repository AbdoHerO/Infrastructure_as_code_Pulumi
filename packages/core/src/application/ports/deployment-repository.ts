import type { PersistenceError, Result } from '@cloudforge/shared';

/** Lifecycle status of a deployment. */
export type DeploymentStatus = 'pending' | 'running' | 'success' | 'failed';

/** A persisted deployment record. */
export interface DeploymentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly status: DeploymentStatus;
  readonly strategy: string;
  readonly outputs: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Fields that may change as a deployment progresses. */
export interface DeploymentUpdate {
  readonly status?: DeploymentStatus;
  readonly outputs?: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

/** Persistence port for deployments. */
export interface DeploymentRepository {
  create(record: DeploymentRecord): Promise<Result<void, PersistenceError>>;
  update(id: string, patch: DeploymentUpdate): Promise<Result<void, PersistenceError>>;
  listByProject(projectId: string): Promise<Result<DeploymentRecord[], PersistenceError>>;
  countAll(): Promise<Result<number, PersistenceError>>;
}
