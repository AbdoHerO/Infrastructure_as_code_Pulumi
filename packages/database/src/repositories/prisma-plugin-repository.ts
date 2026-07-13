import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { InstalledPluginRecord, PluginRepository } from '@cloudforge/core';
import type { Db } from '../client.js';

/** Prisma/SQLite implementation of the {@link PluginRepository} port. */
export class PrismaPluginRepository implements PluginRepository {
  constructor(private readonly db: Db) {}

  async listInstalled(): Promise<Result<InstalledPluginRecord[], PersistenceError>> {
    return guard('list plugins', async () => {
      const rows = await this.db.plugin.findMany();
      return rows.map((row) => ({ id: row.id, enabled: row.enabled }));
    });
  }

  async upsert(
    id: string,
    enabled: boolean,
    manifestJson: string,
  ): Promise<Result<void, PersistenceError>> {
    return guard('install plugin', async () => {
      const manifest = JSON.parse(manifestJson) as {
        name?: string;
        version?: string;
        kind?: string;
      };
      const data = {
        name: manifest.name ?? id,
        version: manifest.version ?? '0.0.0',
        kind: manifest.kind ?? 'unknown',
        enabled,
        manifest: manifestJson,
      };
      await this.db.plugin.upsert({
        where: { id },
        create: { id, ...data },
        update: { enabled, manifest: manifestJson },
      });
    });
  }

  async remove(id: string): Promise<Result<void, PersistenceError>> {
    return guard('uninstall plugin', async () => {
      await this.db.plugin.deleteMany({ where: { id } });
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
