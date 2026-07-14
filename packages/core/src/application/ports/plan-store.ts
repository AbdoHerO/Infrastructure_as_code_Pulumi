import type { PersistenceError, Result } from '@cloudforge/shared';
import type { InfrastructurePlan } from '../infrastructure/infrastructure-plan.js';

/** Persistence port for a project's infrastructure plan. */
export interface PlanStore {
  load(projectId: string): Promise<Result<InfrastructurePlan | null, PersistenceError>>;
  save(projectId: string, plan: InfrastructurePlan): Promise<Result<void, PersistenceError>>;
  delete(projectId: string): Promise<Result<void, PersistenceError>>;
}
