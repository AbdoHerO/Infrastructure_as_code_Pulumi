import bootstrapSql from '../prisma/bootstrap.sql?raw';
import type { Db } from './client.js';

interface TableRow {
  readonly name: string;
}

/**
 * Ensure the SQLite schema exists in a fresh database.
 *
 * The DDL is derived from `schema.prisma` (via `prisma migrate diff`) and
 * inlined at build time, keeping `schema.prisma` the single source of truth.
 * On an existing database this is a no-op — a lightweight guard checks for the
 * `Project` table before running any statement.
 */
export async function ensureSchema(db: Db): Promise<void> {
  const tables = await db.$queryRawUnsafe<TableRow[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='Project'",
  );
  if (tables.length > 0) return;

  const statements = bootstrapSql
    // Strip line comments so they don't leak into split statements.
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await db.$executeRawUnsafe(statement);
  }
}
