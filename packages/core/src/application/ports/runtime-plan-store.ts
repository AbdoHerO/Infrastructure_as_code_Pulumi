import type { ConflictError, PersistenceError, Result } from '@cloudforge/shared';
import type { VpsRuntimePlan } from '../vps-runtime/vps-runtime-plan.js';

/**
 * Persistence port for a VPS target's desired runtime.
 *
 * Mirrors `PlanStore`: a missing plan is `ok(null)`, not a `NotFoundError` — a
 * target CloudForge has never managed is a normal state, not a failure. The
 * service turns absence into an empty legacy-mode plan.
 */
export interface RuntimePlanStore {
  load(targetId: string): Promise<Result<VpsRuntimePlan | null, PersistenceError>>;
  /**
   * Atomically persist `plan` only when the stored version still equals
   * `expectedVersion`. The store, rather than the Application service, owns the
   * final compare-and-swap so two concurrent writers cannot both pass a
   * read-then-write version check and silently overwrite one another.
   */
  save(
    targetId: string,
    plan: VpsRuntimePlan,
    expectedVersion: number,
  ): Promise<Result<void, PersistenceError | ConflictError>>;
  delete(targetId: string): Promise<Result<void, PersistenceError>>;
}
