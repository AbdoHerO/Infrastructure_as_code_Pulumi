import type { DeploymentRecord, DeploymentStatus } from '../ports/deployment-repository.js';

/** Transport-safe view of a deployment for the renderer. */
export interface DeploymentDto {
  readonly id: string;
  readonly projectId: string;
  readonly status: DeploymentStatus;
  readonly strategy: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

/** Map a persisted record to its transport DTO. */
export function toDeploymentDto(record: DeploymentRecord): DeploymentDto {
  return {
    id: record.id,
    projectId: record.projectId,
    status: record.status,
    strategy: record.strategy,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    createdAt: record.createdAt,
  };
}
