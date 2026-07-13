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

interface ForeignKeyRow {
  readonly table: string;
  readonly from: string;
}

/** Hooks the caller can use to react to a destructive migration step. */
export interface MigrateSchemaHooks {
  /** Invoked once, immediately before the Project table is rebuilt. */
  readonly onBeforeProjectRebuild?: () => Promise<void>;
}

/**
 * Apply idempotent, in-place migrations to an existing database.
 *
 * Early builds shipped a `Project.providerId` foreign key that pointed at the
 * unused `Provider` table, so linking a project to a stored credential violated
 * the constraint. SQLite cannot alter a foreign key in place, so we rebuild the
 * `Project` table with the corrected `providerId → Credential` constraint,
 * preserving all rows. The check is cheap and the rewrite runs only when the old
 * constraint is still present, so this is safe to call on every startup.
 *
 * @returns `true` when a migration was applied, `false` when nothing was needed.
 */
export async function migrateSchema(db: Db, hooks: MigrateSchemaHooks = {}): Promise<boolean> {
  const tables = await db.$queryRawUnsafe<TableRow[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='Project'",
  );
  if (tables.length === 0) return false; // Fresh DB — ensureSchema built it correctly.

  const foreignKeys = await db.$queryRawUnsafe<ForeignKeyRow[]>('PRAGMA foreign_key_list("Project")');
  const providerFk = foreignKeys.find((fk) => fk.from === 'providerId');
  if (providerFk?.table !== 'Provider') return false; // Already correct (or no FK).

  await hooks.onBeforeProjectRebuild?.();

  // Disable foreign keys so dropping the old table does not cascade-delete
  // deployments/activities/SSH keys that reference it. Preserved rows keep the
  // same ids, so those child references remain valid after the swap.
  await db.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  try {
    await db.$executeRawUnsafe(
      `CREATE TABLE "Project_new" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "environment" TEXT NOT NULL,
        "region" TEXT NOT NULL,
        "providerId" TEXT,
        "templateId" TEXT,
        "status" TEXT NOT NULL DEFAULT 'draft',
        "tags" TEXT NOT NULL DEFAULT '[]',
        "variables" TEXT NOT NULL DEFAULT '{}',
        "notes" TEXT NOT NULL DEFAULT '',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "Project_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Credential" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )`,
    );
    // Copy every row; null out any providerId that doesn't resolve to a real
    // credential so it can't violate the new constraint.
    await db.$executeRawUnsafe(
      `INSERT INTO "Project_new" (
        "id","name","description","environment","region","providerId",
        "templateId","status","tags","variables","notes","createdAt","updatedAt"
      ) SELECT
        "id","name","description","environment","region",
        CASE WHEN "providerId" IN (SELECT "id" FROM "Credential") THEN "providerId" ELSE NULL END,
        "templateId","status","tags","variables","notes","createdAt","updatedAt"
      FROM "Project"`,
    );
    await db.$executeRawUnsafe('DROP TABLE "Project"');
    await db.$executeRawUnsafe('ALTER TABLE "Project_new" RENAME TO "Project"');
    await db.$executeRawUnsafe('CREATE INDEX "Project_updatedAt_idx" ON "Project"("updatedAt")');
  } finally {
    await db.$executeRawUnsafe('PRAGMA foreign_keys=ON');
  }
  return true;
}
