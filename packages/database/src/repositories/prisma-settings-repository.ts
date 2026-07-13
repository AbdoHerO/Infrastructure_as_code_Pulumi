import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { SettingsRepository } from '@cloudforge/core';
import type { Db } from '../client.js';

/** Prisma/SQLite implementation of the {@link SettingsRepository} port. */
export class PrismaSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<Result<string | null, PersistenceError>> {
    return guard('read setting', async () => {
      const row = await this.db.setting.findUnique({ where: { key } });
      return row?.value ?? null;
    });
  }

  async set(key: string, value: string): Promise<Result<void, PersistenceError>> {
    return guard('write setting', async () => {
      await this.db.setting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    });
  }
}

async function guard<T>(
  action: string,
  fn: () => Promise<T>,
): Promise<Result<T, PersistenceError>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(new PersistenceError(`Failed to ${action}`, { cause }));
  }
}
