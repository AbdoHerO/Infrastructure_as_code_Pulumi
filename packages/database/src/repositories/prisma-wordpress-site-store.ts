import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { ProjectContext, WordPressSiteRecord, WordPressSiteStore } from '@cloudforge/core';
import type { Db } from '../client.js';

const KEY = 'wordpress:sites';

/**
 * WordPress site records as one JSON list in the active project's Setting
 * table. Project backups, exports and imports copy Setting rows, so sites move
 * with their project; the passwords are a separate encrypted credential.
 */
export class PrismaWordPressSiteStore implements WordPressSiteStore {
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
  ) {}

  async list(): Promise<Result<WordPressSiteRecord[], PersistenceError>> {
    try {
      return ok(await this.read(this.context.requireActive().projectId));
    } catch (cause) {
      return err(new PersistenceError('Failed to load WordPress sites', { cause }));
    }
  }

  async save(record: WordPressSiteRecord): Promise<Result<void, PersistenceError>> {
    return this.change((sites) => [...sites.filter((site) => site.id !== record.id), record]);
  }

  async remove(id: string): Promise<Result<void, PersistenceError>> {
    return this.change((sites) => sites.filter((site) => site.id !== id));
  }

  private async change(
    update: (sites: WordPressSiteRecord[]) => WordPressSiteRecord[],
  ): Promise<Result<void, PersistenceError>> {
    try {
      const projectId = this.context.requireActive().projectId;
      await this.db.$transaction(async (tx) => {
        const row = await tx.setting.findUnique({
          where: { projectId_key: { projectId, key: KEY } },
        });
        const value = JSON.stringify(update(row ? parse(row.value) : []));
        await tx.setting.upsert({
          where: { projectId_key: { projectId, key: KEY } },
          create: { projectId, key: KEY, value },
          update: { value },
        });
      });
      return ok(undefined);
    } catch (cause) {
      return err(new PersistenceError('Failed to save WordPress sites', { cause }));
    }
  }

  private async read(projectId: string): Promise<WordPressSiteRecord[]> {
    const row = await this.db.setting.findUnique({
      where: { projectId_key: { projectId, key: KEY } },
    });
    return row ? parse(row.value) : [];
  }
}

function parse(value: string): WordPressSiteRecord[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? (parsed as WordPressSiteRecord[]) : [];
}
