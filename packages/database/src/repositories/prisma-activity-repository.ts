import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { ActivityRecord, ActivityRepository } from '@cloudforge/core';
import type { Activity as PrismaActivity } from '@prisma/client';
import type { Db } from '../client.js';

/** Prisma/SQLite implementation of the {@link ActivityRepository} port. */
export class PrismaActivityRepository implements ActivityRepository {
  constructor(private readonly db: Db) {}

  async create(record: ActivityRecord): Promise<Result<void, PersistenceError>> {
    return guard('record activity', async () => {
      await this.db.activity.create({
        data: {
          id: record.id,
          projectId: record.projectId,
          type: record.type,
          message: record.message,
          metadata: record.metadata,
          createdAt: new Date(record.createdAt),
        },
      });
    });
  }

  async list(limit: number): Promise<Result<ActivityRecord[], PersistenceError>> {
    return guard('list activity', async () => {
      const rows = await this.db.activity.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(limit, 1000)),
      });
      return rows.map(toRecord);
    });
  }
}

function toRecord(row: PrismaActivity): ActivityRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
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
