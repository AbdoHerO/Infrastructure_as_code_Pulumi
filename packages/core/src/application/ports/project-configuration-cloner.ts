import type { PersistenceError, Result } from '@cloudforge/shared';

export interface ClonedProjectLinks {
  readonly providerId: string | null;
  readonly templateId: string | null;
}

/**
 * Copies reusable, project-owned configuration into a newly-created project.
 * Live targets, deployments, pipelines, activity, logs and cloud state are
 * intentionally outside this port.
 */
export interface ProjectConfigurationCloner {
  clone(
    sourceProjectId: string,
    targetProjectId: string,
  ): Promise<Result<ClonedProjectLinks, PersistenceError>>;
}
