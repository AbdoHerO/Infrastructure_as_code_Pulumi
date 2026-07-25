import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type {
  CredentialId,
  CredentialKind,
  CredentialRecord,
  CredentialRepository,
  ProjectContext,
} from '@cloudforge/core';
import type { Credential as PrismaCredential } from '@prisma/client';
import type { Db } from '../client.js';

/** Prisma/SQLite implementation of the {@link CredentialRepository} port. */
export class PrismaCredentialRepository implements CredentialRepository {
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
  ) {}

  async findAll(): Promise<Result<CredentialRecord[], PersistenceError>> {
    return guard('list credentials', async () => {
      const rows = await this.db.credential.findMany({
        where: { projectId: this.projectId() },
        orderBy: { updatedAt: 'desc' },
      });
      return rows.map(toRecord);
    });
  }

  async findById(id: CredentialId): Promise<Result<CredentialRecord | null, PersistenceError>> {
    return guard('load credential', async () => {
      const row = await this.db.credential.findFirst({
        where: { id, projectId: this.projectId() },
      });
      return row ? toRecord(row) : null;
    });
  }

  async save(record: CredentialRecord): Promise<Result<void, PersistenceError>> {
    return guard('save credential', async () => {
      const data = {
        id: record.id,
        projectId: this.projectId(),
        kind: record.kind,
        name: record.name,
        providerId: record.providerId,
        ciphertext: record.ciphertext,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      };
      const updated = await this.db.credential.updateMany({
        where: { id: record.id, projectId: data.projectId },
        data,
      });
      if (updated.count === 0) await this.db.credential.create({ data });
    });
  }

  async delete(id: CredentialId): Promise<Result<void, PersistenceError>> {
    return guard('delete credential', async () => {
      await this.db.credential.deleteMany({ where: { id, projectId: this.projectId() } });
    });
  }

  private projectId(): string {
    return this.context.requireActive().projectId;
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
