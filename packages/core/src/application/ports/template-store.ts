import type { PersistenceError, Result } from '@cloudforge/shared';
import type { InfrastructurePlan } from '../infrastructure/infrastructure-plan.js';

/** Transport-safe summary of a user-saved infrastructure template. */
export interface CustomTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** A user-saved infrastructure template: a named, reusable plan. */
export interface CustomTemplate extends CustomTemplateSummary {
  readonly plan: InfrastructurePlan;
}

/** Persistence port for user-saved (custom) infrastructure templates. */
export interface TemplateStore {
  list(): Promise<Result<CustomTemplateSummary[], PersistenceError>>;
  get(id: string): Promise<Result<CustomTemplate | null, PersistenceError>>;
  save(template: CustomTemplate): Promise<Result<void, PersistenceError>>;
  delete(id: string): Promise<Result<void, PersistenceError>>;
}
