import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { InfrastructurePlan, PlanStore, ProjectContext } from '@cloudforge/core';
import type { Db } from '../client.js';

/**
 * Stores a project's infrastructure plan as a JSON blob in the Setting table,
 * keyed by `plan:<projectId>`. A dedicated table can replace this transparently
 * later — the {@link PlanStore} port is unchanged.
 */
export class PrismaPlanStore implements PlanStore {
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
  ) {}

  private key(projectId: string): string {
    return `plan:${projectId}`;
  }

  async load(projectId: string): Promise<Result<InfrastructurePlan | null, PersistenceError>> {
    try {
      this.assertProject(projectId);
      const row = await this.db.setting.findUnique({
        where: { projectId_key: { projectId, key: this.key(projectId) } },
      });
      if (!row) return ok(null);
      return ok(JSON.parse(row.value) as InfrastructurePlan);
    } catch (cause) {
      return err(new PersistenceError('Failed to load infrastructure plan', { cause }));
    }
  }

  async save(projectId: string, plan: InfrastructurePlan): Promise<Result<void, PersistenceError>> {
    try {
      this.assertProject(projectId);
      const value = JSON.stringify(plan);
      await this.db.setting.upsert({
        where: { projectId_key: { projectId, key: this.key(projectId) } },
        create: { projectId, key: this.key(projectId), value },
        update: { value },
      });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to save infrastructure plan', { cause }));
    }
  }

  async delete(projectId: string): Promise<Result<void, PersistenceError>> {
    try {
      this.assertProject(projectId);
      await this.db.setting.deleteMany({ where: { projectId, key: this.key(projectId) } });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to delete infrastructure plan', { cause }));
    }
  }

  private assertProject(projectId: string): void {
    if (this.context.requireActive().projectId !== projectId) {
      throw new Error('Infrastructure plan belongs to another project');
    }
  }
}
