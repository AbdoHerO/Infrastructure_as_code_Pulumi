import { ConflictError, err, ok, PersistenceError, type Result } from '@cloudforge/shared';
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
 * Parsing is defensive rather than a bare cast. This row is the only record of a
 * target's intent, so malformed or cross-target data must fail closed instead of
 * silently turning a managed production target into an empty legacy plan.
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
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return err(new PersistenceError('Stored runtime plan is malformed'));
      const plan = parsed as VpsRuntimePlan;
      if (plan.targetId !== targetId)
        return err(new PersistenceError('Stored runtime plan belongs to a different target'));
      return ok(plan);
    } catch (cause) {
      return err(new PersistenceError('Failed to load runtime plan', { cause }));
    }
  }

  async save(
    targetId: string,
    plan: VpsRuntimePlan,
    expectedVersion: number,
  ): Promise<Result<void, PersistenceError | ConflictError>> {
    try {
      const key = this.key(targetId);
      const value = JSON.stringify(plan);
      const current = await this.db.setting.findUnique({ where: { key } });
      if (!current) {
        if (expectedVersion !== 0)
          return err(new ConflictError('Runtime plan changed before it could be saved'));
        try {
          await this.db.setting.create({ data: { key, value } });
        } catch (cause) {
          if (isUniqueConstraint(cause))
            return err(new ConflictError('Runtime plan changed before it could be saved'));
          throw cause;
        }
        return ok(undefined);
      }

      const currentVersion = storedVersion(current.value);
      if (currentVersion !== expectedVersion)
        return err(new ConflictError('Runtime plan changed before it could be saved'));

      // The value predicate is the actual compare-and-swap. Even if another
      // process writes between the read above and this update, its value no
      // longer matches and this writer receives a conflict instead of erasing
      // the newer topology.
      const updated = await this.db.setting.updateMany({
        where: { key, value: current.value },
        data: { value },
      });
      if (updated.count !== 1)
        return err(new ConflictError('Runtime plan changed before it could be saved'));
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

function storedVersion(value: string): number {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Stored runtime plan is malformed');
  const version = (parsed as { version?: unknown }).version;
  if (!Number.isInteger(version) || Number(version) < 0)
    throw new Error('Stored runtime plan has an invalid version');
  return Number(version);
}

function isUniqueConstraint(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'P2002'
  );
}
