import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type {
  CustomTemplate,
  CustomTemplateSummary,
  InfrastructurePlan,
  ProjectContext,
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
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
  ) {}

  async list(): Promise<Result<CustomTemplateSummary[], PersistenceError>> {
    try {
      const rows = await this.db.template.findMany({
        where: { projectId: this.projectId(), kind: KIND, builtIn: false },
        orderBy: { updatedAt: 'desc' },
      });
      return ok(rows.map((row) => ({ id: row.id, name: row.name, description: row.description })));
    } catch (cause) {
      return err(new PersistenceError('Failed to list custom templates', { cause }));
    }
  }

  async get(id: string): Promise<Result<CustomTemplate | null, PersistenceError>> {
    try {
      const row = await this.db.template.findFirst({
        where: { id, projectId: this.projectId() },
      });
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
        projectId: this.projectId(),
        name: template.name,
        description: template.description,
        definition: JSON.stringify(template.plan),
        builtIn: false,
      };
      const updated = await this.db.template.updateMany({
        where: { id: template.id, projectId: data.projectId },
        data,
      });
      if (updated.count === 0) {
        await this.db.template.create({ data: { id: template.id, ...data } });
      }
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to save custom template', { cause }));
    }
  }

  async delete(id: string): Promise<Result<void, PersistenceError>> {
    try {
      await this.db.template.deleteMany({
        where: { id, projectId: this.projectId(), kind: KIND },
      });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to delete custom template', { cause }));
    }
  }

  private projectId(): string {
    return this.context.requireActive().projectId;
  }
}
