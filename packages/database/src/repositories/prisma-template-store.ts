import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type {
  CustomTemplate,
  CustomTemplateSummary,
  InfrastructurePlan,
  TemplateStore,
} from '@cloudforge/core';
import type { Db } from '../client.js';

const KIND = 'infrastructure';

/**
 * Stores user-saved infrastructure templates in the `Template` table (rows with
 * kind `infrastructure`). The plan is serialised into the `definition` column as
 * JSON, mirroring the plan-store convention.
 */
export class PrismaTemplateStore implements TemplateStore {
  constructor(private readonly db: Db) {}

  async list(): Promise<Result<CustomTemplateSummary[], PersistenceError>> {
    try {
      const rows = await this.db.template.findMany({
        where: { kind: KIND, builtIn: false },
        orderBy: { updatedAt: 'desc' },
      });
      return ok(rows.map((row) => ({ id: row.id, name: row.name, description: row.description })));
    } catch (cause) {
      return err(new PersistenceError('Failed to list custom templates', { cause }));
    }
  }

  async get(id: string): Promise<Result<CustomTemplate | null, PersistenceError>> {
    try {
      const row = await this.db.template.findUnique({ where: { id } });
      if (row?.kind !== KIND) return ok(null);
      return ok({
        id: row.id,
        name: row.name,
        description: row.description,
        plan: JSON.parse(row.definition) as InfrastructurePlan,
      });
    } catch (cause) {
      return err(new PersistenceError('Failed to load custom template', { cause }));
    }
  }

  async save(template: CustomTemplate): Promise<Result<void, PersistenceError>> {
    try {
      const data = {
        kind: KIND,
        name: template.name,
        description: template.description,
        definition: JSON.stringify(template.plan),
        builtIn: false,
      };
      await this.db.template.upsert({
        where: { id: template.id },
        create: { id: template.id, ...data },
        update: data,
      });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to save custom template', { cause }));
    }
  }

  async delete(id: string): Promise<Result<void, PersistenceError>> {
    try {
      await this.db.template.deleteMany({ where: { id, kind: KIND } });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to delete custom template', { cause }));
    }
  }
}
