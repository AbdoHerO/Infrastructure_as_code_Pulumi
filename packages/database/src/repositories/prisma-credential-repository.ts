import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type {
  CredentialId,
  CredentialKind,
  CredentialRecord,
  CredentialRepository,
} from '@cloudforge/core';
import type { Credential as PrismaCredential } from '@prisma/client';
import type { Db } from '../client.js';

/** Prisma/SQLite implementation of the {@link CredentialRepository} port. */
export class PrismaCredentialRepository implements CredentialRepository {
  constructor(private readonly db: Db) {}

  async findAll(): Promise<Result<CredentialRecord[], PersistenceError>> {
    return guard('list credentials', async () => {
      const rows = await this.db.credential.findMany({ orderBy: { updatedAt: 'desc' } });
      return rows.map(toRecord);
    });
  }

  async findById(id: CredentialId): Promise<Result<CredentialRecord | null, PersistenceError>> {
    return guard('load credential', async () => {
      const row = await this.db.credential.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    });
  }

  async save(record: CredentialRecord): Promise<Result<void, PersistenceError>> {
    return guard('save credential', async () => {
      const data = {
        id: record.id,
        kind: record.kind,
        name: record.name,
        providerId: record.providerId,
        ciphertext: record.ciphertext,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      };
      await this.db.credential.upsert({ where: { id: record.id }, create: data, update: data });
    });
  }

  async delete(id: CredentialId): Promise<Result<void, PersistenceError>> {
    return guard('delete credential', async () => {
      await this.db.credential.deleteMany({ where: { id } });
    });
  }
}

function toRecord(row: PrismaCredential): CredentialRecord {
  return {
    id: row.id,
    kind: row.kind as CredentialKind,
    name: row.name,
    providerId: row.providerId,
    ciphertext: row.ciphertext,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
