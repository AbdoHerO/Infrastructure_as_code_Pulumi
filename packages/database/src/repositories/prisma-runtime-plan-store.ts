import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import { type RuntimePlanStore, type VpsRuntimePlan } from '@cloudforge/core';
import type { Db } from '../client.js';

/**
 * Stores a target's desired runtime as versioned JSON in the Setting table,
 * keyed by `runtime-plan:<targetId>`.
 *
 * Follows `PrismaPlanStore`, whose own note anticipated this: a dedicated table
 * can replace it later without the port changing. Keeping the plan inside
 * `cloudforge.db` also means portable backup covers it for free — `VACUUM INTO`
 * snapshots the whole file.
 *
 * Parsing is defensive rather than a bare cast: this row is the only record of a
 * target's intent, and a corrupt one should degrade to "not managed yet" instead
 * of failing every read for that target.
 */
export class PrismaRuntimePlanStore implements RuntimePlanStore {
  constructor(private readonly db: Db) {}

  private key(targetId: string): string {
    return `runtime-plan:${targetId}`;
  }

  async load(targetId: string): Promise<Result<VpsRuntimePlan | null, PersistenceError>> {
    try {
      const row = await this.db.setting.findUnique({ where: { key: this.key(targetId) } });
      if (!row) return ok(null);
      const parsed: unknown = JSON.parse(row.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ok(null);
      const plan = parsed as VpsRuntimePlan;
      return ok(plan.targetId === targetId ? plan : null);
    } catch (cause) {
      return err(new PersistenceError('Failed to load runtime plan', { cause }));
    }
  }

  async save(targetId: string, plan: VpsRuntimePlan): Promise<Result<void, PersistenceError>> {
    try {
      const value = JSON.stringify(plan);
      await this.db.setting.upsert({
        where: { key: this.key(targetId) },
        create: { key: this.key(targetId), value },
        update: { value },
      });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to save runtime plan', { cause }));
    }
  }

  async delete(targetId: string): Promise<Result<void, PersistenceError>> {
    try {
      // `deleteMany` rather than `delete`: removing a plan that was never saved
      // is a no-op, not an error.
      await this.db.setting.deleteMany({ where: { key: this.key(targetId) } });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to delete runtime plan', { cause }));
    }
  }
}
