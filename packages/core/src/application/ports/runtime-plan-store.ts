import type { PersistenceError, Result } from '@cloudforge/shared';
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
  save(targetId: string, plan: VpsRuntimePlan): Promise<Result<void, PersistenceError>>;
  delete(targetId: string): Promise<Result<void, PersistenceError>>;
}
