import type { PersistenceError, Result } from '@cloudforge/shared';

/** Non-sensitive aggregate counts displayed by the locked workspace picker. */
export interface ProjectInfrastructureSummary {
  readonly infrastructureConfigured: boolean;
  readonly targetCount: number;
  readonly pipelineCount: number;
  readonly deploymentCount: number;
}

/**
 * Read-only projection port. It deliberately returns counts rather than
 * resource records so a locked project cannot expose workspace content.
 */
export interface ProjectSummaryReader {
  readAll(): Promise<Result<ReadonlyMap<string, ProjectInfrastructureSummary>, PersistenceError>>;
}
