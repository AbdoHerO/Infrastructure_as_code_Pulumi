import { newUuid } from '@cloudforge/shared';
import type { Db } from './client.js';

interface ColumnRow {
  readonly name: string;
}

interface CountRow {
  readonly count: bigint | number;
}

interface ProjectRow {
  readonly id: string;
}

interface CredentialRow {
  readonly id: string;
  readonly providerId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly ciphertext: string;
  readonly metadata: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

interface SettingRow {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string | Date;
}

interface PluginRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: string;
  readonly enabled: number | boolean;
  readonly manifest: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

const OWNED_TABLES = [
  'Provider',
  'Credential',
  'VpsTarget',
  'JenkinsPipeline',
  'Template',
  'LogEntry',
  'SshKey',
  'Secret',
  'Setting',
  'Plugin',
  'Activity',
] as const;

export interface ProjectOwnershipMigrationHooks {
  readonly onBeforeMigration?: () => Promise<void>;
}

/**
 * Upgrade the former global workspace into isolated project-owned rows.
 *
 * This deliberately uses raw SQLite while the legacy schema is in flux. It is
 * idempotent, runs before scoped repositories are constructed, and never
 * decrypts credential payloads.
 */
export async function migrateProjectOwnership(
  db: Db,
  hooks: ProjectOwnershipMigrationHooks = {},
): Promise<boolean> {
  if (await hasColumn(db, 'Credential', 'projectId')) {
    await ensureSystemSettingsTable(db);
    await createOwnershipGuards(db);
    await createReferenceOwnershipGuards(db);
    return false;
  }
  await hooks.onBeforeMigration?.();

  await db.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  try {
    return await db.$transaction(async (tx) => {
      for (const table of OWNED_TABLES) {
        if (!(await hasColumn(tx as Db, table, 'projectId'))) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "projectId" TEXT`);
        }
      }

      let projects = await tx.$queryRawUnsafe<ProjectRow[]>(
        'SELECT "id" FROM "Project" ORDER BY "createdAt", "id"',
      );
      if (projects.length === 0 && (await hasLegacyData(tx as Db))) {
        const id = newUuid();
        const now = new Date().toISOString();
        await tx.$executeRawUnsafe(
          `INSERT INTO "Project" (
            "id","name","description","environment","region","status","tags","variables",
            "notes","icon","color","passkeyVersion","createdAt","updatedAt"
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id,
          'Default Project',
          'Automatically created from the pre-workspace CloudForge installation.',
          'development',
          'local',
          'draft',
          '[]',
          '{}',
          '',
          '',
          '',
          1,
          now,
          now,
        );
        projects = [{ id }];
      }

      const fallback = projects[0]?.id;
      if (!fallback) {
        await rebuildSettings(tx as Db, [], new Map());
        await rebuildPlugins(tx as Db, []);
        await createOwnershipGuards(tx as Db);
        await createReferenceOwnershipGuards(tx as Db);
        return true;
      }

      await tx.$executeRawUnsafe(
        `UPDATE "VpsTarget"
         SET "projectId" = CASE
           WHEN "managedProjectId" IN (SELECT "id" FROM "Project") THEN "managedProjectId"
           ELSE ?
         END`,
        fallback,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "JenkinsPipeline"
         SET "projectId" = COALESCE(
           (SELECT "projectId" FROM "VpsTarget" WHERE "VpsTarget"."id" = "JenkinsPipeline"."targetId"),
           ?
         )`,
        fallback,
      );

      await isolateCredentials(tx as Db, fallback);

      await tx.$executeRawUnsafe('UPDATE "Provider" SET "projectId" = ?', fallback);
      await tx.$executeRawUnsafe(
        `UPDATE "Activity" SET "projectId" = ?
         WHERE "projectId" IS NULL OR "projectId" NOT IN (SELECT "id" FROM "Project")`,
        fallback,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "LogEntry"
         SET "projectId" = COALESCE(
           (SELECT "projectId" FROM "Deployment" WHERE "Deployment"."id" = "LogEntry"."deploymentId"),
           ?
         )`,
        fallback,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "SshKey" SET "projectId" = ?
         WHERE "projectId" IS NULL OR "projectId" NOT IN (SELECT "id" FROM "Project")`,
        fallback,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "Secret"
         SET "projectId" = CASE
           WHEN "scope" LIKE 'project:%'
             AND substr("scope", 9) IN (SELECT "id" FROM "Project")
           THEN substr("scope", 9)
           ELSE ?
         END`,
        fallback,
      );

      await duplicateTemplates(
        tx as Db,
        projects.map((project) => project.id),
        fallback,
      );

      const targetRows = await tx.$queryRawUnsafe<{ id: string; projectId: string }[]>(
        'SELECT "id", "projectId" FROM "VpsTarget"',
      );
      const targetProjects = new Map(targetRows.map((row) => [row.id, row.projectId]));
      await rebuildSettings(
        tx as Db,
        projects.map((project) => project.id),
        targetProjects,
      );
      await rebuildPlugins(
        tx as Db,
        projects.map((project) => project.id),
      );
      await replaceScopedIndexes(tx as Db);

      // Defensive final backfill: no scoped repository may ever receive null.
      for (const table of OWNED_TABLES.filter(
        (name) => name !== 'Setting' && name !== 'Secret' && name !== 'Plugin',
      )) {
        await tx.$executeRawUnsafe(
          `UPDATE "${table}" SET "projectId" = ? WHERE "projectId" IS NULL`,
          fallback,
        );
      }
      await createOwnershipGuards(tx as Db);
      await createReferenceOwnershipGuards(tx as Db);
      return true;
    });
  } finally {
    await db.$executeRawUnsafe('PRAGMA foreign_keys=ON');
  }
}

async function ensureSystemSettingsTable(db: Db): Promise<void> {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SystemSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
  )`);
}

/**
 * Legacy SQLite tables gained projectId through ALTER TABLE, which cannot add
 * NOT NULL or a foreign key safely. These guards make the same invariant
 * enforceable until a future full table rebuild.
 */
async function createOwnershipGuards(db: Db): Promise<void> {
  for (const table of OWNED_TABLES) {
    for (const operation of ['INSERT', 'UPDATE'] as const) {
      const trigger = `${table}_require_project_${operation.toLowerCase()}`;
      await db.$executeRawUnsafe(`CREATE TRIGGER IF NOT EXISTS "${trigger}"
        BEFORE ${operation} ON "${table}"
        FOR EACH ROW
        WHEN NEW."projectId" IS NULL
          OR NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = NEW."projectId")
        BEGIN
          SELECT RAISE(ABORT, 'project ownership is required');
        END`);
    }
  }
}

/**
 * SQLite foreign keys prove that a referenced row exists, but not that both
 * rows belong to the same workspace. These triggers make cross-project
 * references impossible even if a future adapter accidentally omits a
 * repository scope.
 */
async function createReferenceOwnershipGuards(db: Db): Promise<void> {
  const guards = [
    {
      table: 'Project',
      operations: ['UPDATE'] as const,
      when: 'NEW."providerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Credential" WHERE "id" = NEW."providerId" AND "projectId" = NEW."id")',
    },
    {
      table: 'Credential',
      operations: ['INSERT', 'UPDATE'] as const,
      when: 'NEW."providerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Provider" WHERE "id" = NEW."providerId" AND "projectId" = NEW."projectId")',
    },
    {
      table: 'VpsTarget',
      operations: ['INSERT', 'UPDATE'] as const,
      when: 'NEW."sshCredentialId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Credential" WHERE "id" = NEW."sshCredentialId" AND "projectId" = NEW."projectId")',
    },
    {
      table: 'JenkinsPipeline',
      operations: ['INSERT', 'UPDATE'] as const,
      when: `NOT EXISTS (SELECT 1 FROM "VpsTarget" WHERE "id" = NEW."targetId" AND "projectId" = NEW."projectId")
        OR NOT EXISTS (SELECT 1 FROM "Credential" WHERE "id" = NEW."jenkinsCredentialId" AND "projectId" = NEW."projectId")
        OR (NEW."githubCredentialId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Credential" WHERE "id" = NEW."githubCredentialId" AND "projectId" = NEW."projectId"))
        OR (NEW."environmentCredentialId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Credential" WHERE "id" = NEW."environmentCredentialId" AND "projectId" = NEW."projectId"))
        OR (NEW."cloudflareCredentialId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Credential" WHERE "id" = NEW."cloudflareCredentialId" AND "projectId" = NEW."projectId"))`,
    },
    {
      table: 'LogEntry',
      operations: ['INSERT', 'UPDATE'] as const,
      when: 'NEW."deploymentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Deployment" WHERE "id" = NEW."deploymentId" AND "projectId" = NEW."projectId")',
    },
  ] as const;

  for (const guard of guards) {
    for (const operation of guard.operations) {
      const trigger = `${guard.table}_same_project_references_${operation.toLowerCase()}`;
      await db.$executeRawUnsafe(`CREATE TRIGGER IF NOT EXISTS "${trigger}"
        BEFORE ${operation} ON "${guard.table}"
        FOR EACH ROW
        WHEN ${guard.when}
        BEGIN
          SELECT RAISE(ABORT, 'cross-project reference is forbidden');
        END`);
    }
  }
}

async function isolateCredentials(db: Db, fallback: string): Promise<void> {
  const credentials = await db.$queryRawUnsafe<CredentialRow[]>('SELECT * FROM "Credential"');
  const source = new Map(credentials.map((row) => [row.id, row]));
  const owner = new Map<string, string>();
  const clone = new Map<string, string>();

  const assign = async (
    credentialId: string | null,
    projectId: string,
    updateSql: string,
    rowId: string,
  ): Promise<void> => {
    if (!credentialId) return;
    const record = source.get(credentialId);
    if (!record) return;
    const existingOwner = owner.get(credentialId);
    if (!existingOwner || existingOwner === projectId) {
      owner.set(credentialId, projectId);
      return;
    }
    const cacheKey = `${credentialId}:${projectId}`;
    let id = clone.get(cacheKey);
    if (!id) {
      id = newUuid();
      clone.set(cacheKey, id);
      await db.$executeRawUnsafe(
        `INSERT INTO "Credential" (
          "id","projectId","providerId","kind","name","ciphertext","metadata","createdAt","updatedAt"
        ) VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        projectId,
        null,
        record.kind,
        record.name,
        record.ciphertext,
        record.metadata,
        record.createdAt,
        record.updatedAt,
      );
    }
    await db.$executeRawUnsafe(updateSql, id, rowId);
  };

  const projectRefs = await db.$queryRawUnsafe<{ id: string; providerId: string | null }[]>(
    'SELECT "id", "providerId" FROM "Project"',
  );
  for (const row of projectRefs) {
    await assign(
      row.providerId,
      row.id,
      'UPDATE "Project" SET "providerId" = ? WHERE "id" = ?',
      row.id,
    );
  }

  const targetRefs = await db.$queryRawUnsafe<
    { id: string; projectId: string; sshCredentialId: string | null }[]
  >('SELECT "id", "projectId", "sshCredentialId" FROM "VpsTarget"');
  for (const row of targetRefs) {
    await assign(
      row.sshCredentialId,
      row.projectId,
      'UPDATE "VpsTarget" SET "sshCredentialId" = ? WHERE "id" = ?',
      row.id,
    );
  }

  const fields = [
    'jenkinsCredentialId',
    'githubCredentialId',
    'environmentCredentialId',
    'cloudflareCredentialId',
  ] as const;
  const pipelineRefs = await db.$queryRawUnsafe<
    ({ id: string; projectId: string } & Record<(typeof fields)[number], string | null>)[]
  >(
    `SELECT "id","projectId",${fields.map((field) => `"${field}"`).join(',')} FROM "JenkinsPipeline"`,
  );
  for (const row of pipelineRefs) {
    for (const field of fields) {
      await assign(
        row[field],
        row.projectId,
        `UPDATE "JenkinsPipeline" SET "${field}" = ? WHERE "id" = ?`,
        row.id,
      );
    }
  }

  for (const credential of credentials) {
    await db.$executeRawUnsafe(
      'UPDATE "Credential" SET "projectId" = ? WHERE "id" = ?',
      owner.get(credential.id) ?? fallback,
      credential.id,
    );
  }
}

async function duplicateTemplates(
  db: Db,
  projectIds: readonly string[],
  fallback: string,
): Promise<void> {
  const rows = await db.$queryRawUnsafe<
    {
      id: string;
      kind: string;
      name: string;
      description: string;
      definition: string;
      builtIn: number | boolean;
      createdAt: string | Date;
      updatedAt: string | Date;
    }[]
  >('SELECT * FROM "Template"');
  for (const row of rows) {
    await db.$executeRawUnsafe(
      'UPDATE "Template" SET "projectId" = ? WHERE "id" = ?',
      fallback,
      row.id,
    );
    for (const projectId of projectIds) {
      if (projectId === fallback) continue;
      await db.$executeRawUnsafe(
        `INSERT INTO "Template" (
          "id","projectId","kind","name","description","definition","builtIn","createdAt","updatedAt"
        ) VALUES (?,?,?,?,?,?,?,?,?)`,
        newUuid(),
        projectId,
        row.kind,
        row.name,
        row.description,
        row.definition,
        row.builtIn,
        row.createdAt,
        row.updatedAt,
      );
    }
  }
}

async function rebuildSettings(
  db: Db,
  projectIds: readonly string[],
  targetProjects: ReadonlyMap<string, string>,
): Promise<void> {
  const rows = await db.$queryRawUnsafe<SettingRow[]>(
    'SELECT "key","value","updatedAt" FROM "Setting"',
  );
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SystemSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
  )`);
  for (const row of rows.filter(
    (candidate) => !candidate.key.startsWith('plan:') && !candidate.key.startsWith('runtime-plan:'),
  )) {
    await db.$executeRawUnsafe(
      'INSERT OR REPLACE INTO "SystemSetting" ("key","value","updatedAt") VALUES (?,?,?)',
      row.key,
      row.value,
      row.updatedAt,
    );
  }
  await db.$executeRawUnsafe(`CREATE TABLE "Setting_workspace" (
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("projectId","key"),
    CONSTRAINT "Setting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`);
  for (const row of rows) {
    const owners = settingOwners(row.key, projectIds, targetProjects);
    for (const projectId of owners) {
      await db.$executeRawUnsafe(
        'INSERT OR REPLACE INTO "Setting_workspace" ("projectId","key","value","updatedAt") VALUES (?,?,?,?)',
        projectId,
        row.key,
        row.value,
        row.updatedAt,
      );
    }
  }
  await db.$executeRawUnsafe('DROP TABLE "Setting"');
  await db.$executeRawUnsafe('ALTER TABLE "Setting_workspace" RENAME TO "Setting"');
  await db.$executeRawUnsafe('CREATE INDEX "Setting_projectId_idx" ON "Setting"("projectId")');
}

function settingOwners(
  key: string,
  projectIds: readonly string[],
  targetProjects: ReadonlyMap<string, string>,
): readonly string[] {
  if (key.startsWith('plan:')) {
    const id = key.slice('plan:'.length);
    return projectIds.includes(id) ? [id] : projectIds.slice(0, 1);
  }
  if (key.startsWith('runtime-plan:')) {
    const owner = targetProjects.get(key.slice('runtime-plan:'.length));
    return owner ? [owner] : projectIds.slice(0, 1);
  }
  return projectIds;
}

async function rebuildPlugins(db: Db, projectIds: readonly string[]): Promise<void> {
  const rows = await db.$queryRawUnsafe<PluginRow[]>('SELECT * FROM "Plugin"');
  await db.$executeRawUnsafe(`CREATE TABLE "Plugin_workspace" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("projectId","id"),
    CONSTRAINT "Plugin_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`);
  for (const projectId of projectIds) {
    for (const row of rows) {
      await db.$executeRawUnsafe(
        `INSERT INTO "Plugin_workspace" (
          "id","projectId","name","version","kind","enabled","manifest","createdAt","updatedAt"
        ) VALUES (?,?,?,?,?,?,?,?,?)`,
        row.id,
        projectId,
        row.name,
        row.version,
        row.kind,
        row.enabled,
        row.manifest,
        row.createdAt,
        row.updatedAt,
      );
    }
  }
  await db.$executeRawUnsafe('DROP TABLE "Plugin"');
  await db.$executeRawUnsafe('ALTER TABLE "Plugin_workspace" RENAME TO "Plugin"');
  await db.$executeRawUnsafe('CREATE INDEX "Plugin_projectId_idx" ON "Plugin"("projectId")');
}

async function replaceScopedIndexes(db: Db): Promise<void> {
  const statements = [
    'DROP INDEX IF EXISTS "VpsTarget_managedProjectId_managedResourceName_key"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "VpsTarget_projectId_managedProjectId_managedResourceName_key" ON "VpsTarget"("projectId","managedProjectId","managedResourceName")',
    'CREATE INDEX IF NOT EXISTS "VpsTarget_projectId_idx" ON "VpsTarget"("projectId")',
    'DROP INDEX IF EXISTS "JenkinsPipeline_folder_name_key"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "JenkinsPipeline_projectId_folder_name_key" ON "JenkinsPipeline"("projectId","folder","name")',
    'CREATE INDEX IF NOT EXISTS "JenkinsPipeline_projectId_idx" ON "JenkinsPipeline"("projectId")',
    'CREATE INDEX IF NOT EXISTS "Credential_projectId_idx" ON "Credential"("projectId")',
    'CREATE INDEX IF NOT EXISTS "Provider_projectId_idx" ON "Provider"("projectId")',
    'CREATE INDEX IF NOT EXISTS "Template_projectId_idx" ON "Template"("projectId")',
    'CREATE INDEX IF NOT EXISTS "LogEntry_projectId_idx" ON "LogEntry"("projectId")',
    'CREATE INDEX IF NOT EXISTS "SshKey_projectId_idx" ON "SshKey"("projectId")',
    'DROP INDEX IF EXISTS "Secret_scope_name_key"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "Secret_projectId_name_key" ON "Secret"("projectId","name")',
    'CREATE INDEX IF NOT EXISTS "Secret_projectId_idx" ON "Secret"("projectId")',
    'CREATE INDEX IF NOT EXISTS "Activity_projectId_idx" ON "Activity"("projectId")',
  ];
  for (const statement of statements) await db.$executeRawUnsafe(statement);
}

async function hasLegacyData(db: Db): Promise<boolean> {
  for (const table of OWNED_TABLES) {
    const rows = await db.$queryRawUnsafe<CountRow[]>(`SELECT COUNT(*) AS "count" FROM "${table}"`);
    if (Number(rows[0]?.count ?? 0) > 0) return true;
  }
  const deployments = await db.$queryRawUnsafe<CountRow[]>(
    'SELECT COUNT(*) AS "count" FROM "Deployment"',
  );
  return Number(deployments[0]?.count ?? 0) > 0;
}

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<ColumnRow[]>(`PRAGMA table_info("${table}")`);
  return rows.some((row) => row.name === column);
}
