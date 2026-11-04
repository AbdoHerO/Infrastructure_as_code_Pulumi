import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { ProjectContext } from '@cloudforge/core';
import type { Db } from '../client.js';

/**
 * A list of records as one JSON value in the active project's Setting table.
 * Project backups, exports and imports copy Setting rows, so the records move
 * with their project. Secrets belong in an encrypted credential, not here.
 */
export abstract class PrismaProjectListStore<T extends { readonly id: string }> {
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
    private readonly key: string,
    private readonly label: string,
  ) {}

  async list(): Promise<Result<T[], PersistenceError>> {
    try {
      const projectId = this.context.requireActive().projectId;
      const row = await this.db.setting.findUnique({
        where: { projectId_key: { projectId, key: this.key } },
      });
      return ok(row ? this.parse(row.value) : []);
    } catch (cause) {
      return err(new PersistenceError(`Failed to load ${this.label}`, { cause }));
    }
  }

  async save(record: T): Promise<Result<void, PersistenceError>> {
    return this.change((items) => [...items.filter((item) => item.id !== record.id), record]);
  }

  async remove(id: string): Promise<Result<void, PersistenceError>> {
    return this.change((items) => items.filter((item) => item.id !== id));
  }

  private async change(update: (items: T[]) => T[]): Promise<Result<void, PersistenceError>> {
    try {
      const projectId = this.context.requireActive().projectId;
      await this.db.$transaction(async (tx) => {
        const row = await tx.setting.findUnique({
          where: { projectId_key: { projectId, key: this.key } },
        });
        const value = JSON.stringify(update(row ? this.parse(row.value) : []));
        await tx.setting.upsert({
          where: { projectId_key: { projectId, key: this.key } },
          create: { projectId, key: this.key, value },
          update: { value },
        });
      });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError(`Failed to save ${this.label}`, { cause }));
    }
  }

  private parse(value: string): T[] {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
}
