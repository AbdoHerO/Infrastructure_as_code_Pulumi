import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type Db } from './client.js';
import { migrateProjectOwnership } from './project-ownership-migration.js';
import { ensureSchema, migrateSchema } from './schema-bootstrap.js';

const PROJECT_A = '10000000-0000-4000-8000-000000000001';
const PROJECT_B = '10000000-0000-4000-8000-000000000002';
const created: { directory: string; db: Db }[] = [];

function trackDatabase(directory: string, db: Db): Db {
  created.push({ directory, db });
  return db;
}

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'cloudforge-ownership-'));
  const db = trackDatabase(
    directory,
    createPrismaClient(`file:${join(directory, 'test.db').replace(/\\/g, '/')}`),
  );
  await db.$connect();
  await ensureSchema(db);
  await migrateProjectOwnership(db);
  await db.project.createMany({
    data: [
      { id: PROJECT_A, name: 'A', environment: 'development', region: 'test' },
      { id: PROJECT_B, name: 'B', environment: 'development', region: 'test' },
    ],
  });
  return db;
}

async function legacyDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'cloudforge-legacy-'));
  const db = trackDatabase(
    directory,
    createPrismaClient(`file:${join(directory, 'legacy.db').replace(/\\/g, '/')}`),
  );
  await db.$connect();
  const statements = [
    `CREATE TABLE "Project" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '',
      "environment" TEXT NOT NULL, "region" TEXT NOT NULL, "providerId" TEXT,
      "templateId" TEXT, "status" TEXT NOT NULL DEFAULT 'draft', "tags" TEXT NOT NULL DEFAULT '[]',
      "variables" TEXT NOT NULL DEFAULT '{}', "notes" TEXT NOT NULL DEFAULT '',
      "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Provider" (
      "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "name" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'disconnected', "metadata" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Credential" (
      "id" TEXT PRIMARY KEY, "providerId" TEXT, "kind" TEXT NOT NULL, "name" TEXT NOT NULL,
      "ciphertext" TEXT NOT NULL, "metadata" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "VpsTarget" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "host" TEXT NOT NULL,
      "port" INTEGER NOT NULL DEFAULT 22, "username" TEXT NOT NULL, "sshCredentialId" TEXT,
      "hostKeySha256" TEXT NOT NULL, "lastPreflight" TEXT NOT NULL DEFAULT '',
      "lastPreflightAt" DATETIME, "managedProjectId" TEXT, "managedResourceName" TEXT,
      "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "JenkinsPipeline" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "folder" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '', "targetId" TEXT NOT NULL,
      "jenkinsCredentialId" TEXT NOT NULL, "githubCredentialId" TEXT,
      "repositoryUrl" TEXT NOT NULL DEFAULT '', "branch" TEXT NOT NULL DEFAULT 'main',
      "jenkinsfilePath" TEXT NOT NULL DEFAULT 'Jenkinsfile', "pipelineScript" TEXT NOT NULL DEFAULT '',
      "definitionMode" TEXT NOT NULL DEFAULT 'scm', "parameters" TEXT NOT NULL DEFAULT '[]',
      "environment" TEXT NOT NULL DEFAULT '{}', "environmentCredentialId" TEXT,
      "domain" TEXT NOT NULL DEFAULT '', "applicationPort" INTEGER,
      "cloudflareCredentialId" TEXT, "cloudflareZoneId" TEXT,
      "configureDomain" BOOLEAN NOT NULL DEFAULT false, "applicationRoutes" TEXT NOT NULL DEFAULT '[]',
      "lastStatus" TEXT NOT NULL DEFAULT 'configured', "createdAt" DATETIME NOT NULL,
      "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Template" (
      "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '', "definition" TEXT NOT NULL DEFAULT '{}',
      "builtIn" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL,
      "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Deployment" (
      "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
      "strategy" TEXT NOT NULL DEFAULT '', "outputs" TEXT NOT NULL DEFAULT '{}',
      "startedAt" DATETIME, "finishedAt" DATETIME, "createdAt" DATETIME NOT NULL,
      "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "LogEntry" (
      "id" TEXT PRIMARY KEY, "deploymentId" TEXT, "projectId" TEXT,
      "level" TEXT NOT NULL DEFAULT 'info', "source" TEXT NOT NULL DEFAULT 'app',
      "message" TEXT NOT NULL, "metadata" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "SshKey" (
      "id" TEXT PRIMARY KEY, "projectId" TEXT, "name" TEXT NOT NULL,
      "publicKey" TEXT NOT NULL, "ciphertext" TEXT, "fingerprint" TEXT NOT NULL DEFAULT '',
      "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Secret" (
      "id" TEXT PRIMARY KEY, "scope" TEXT NOT NULL DEFAULT 'global',
      "name" TEXT NOT NULL, "ciphertext" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Setting" (
      "key" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Plugin" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "version" TEXT NOT NULL,
      "kind" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
      "manifest" TEXT NOT NULL DEFAULT '{}', "createdAt" DATETIME NOT NULL,
      "updatedAt" DATETIME NOT NULL
    )`,
    `CREATE TABLE "Activity" (
      "id" TEXT PRIMARY KEY, "projectId" TEXT, "type" TEXT NOT NULL,
      "message" TEXT NOT NULL, "metadata" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL
    )`,
  ];
  for (const statement of statements) await db.$executeRawUnsafe(statement);
  return db;
}

afterEach(async () => {
  for (const fixture of created.splice(0)) {
    await fixture.db.$disconnect();
    await rm(fixture.directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

describe('project ownership database guards', () => {
  it('rejects cross-project credential references', async () => {
    const db = await database();
    try {
      await db.credential.create({
        data: {
          id: '20000000-0000-4000-8000-000000000001',
          projectId: PROJECT_A,
          kind: 'ssh',
          name: 'A key',
          ciphertext: 'encrypted',
        },
      });

      await expect(
        db.vpsTarget.create({
          data: {
            id: '30000000-0000-4000-8000-000000000001',
            projectId: PROJECT_B,
            name: 'B target',
            host: '192.0.2.10',
            username: 'ubuntu',
            sshCredentialId: '20000000-0000-4000-8000-000000000001',
            hostKeySha256: 'SHA256:test',
          },
        }),
        // Prisma normalizes SQLite trigger aborts to its foreign-key error.
      ).rejects.toThrow(/Foreign key constraint violated/);
    } finally {
      await db.$disconnect();
    }
  });

  it('rejects a pipeline whose target or credentials belong to another project', async () => {
    const db = await database();
    try {
      await db.credential.create({
        data: {
          id: '20000000-0000-4000-8000-000000000002',
          projectId: PROJECT_A,
          kind: 'jenkins',
          name: 'Jenkins',
          ciphertext: 'encrypted',
        },
      });
      await db.vpsTarget.create({
        data: {
          id: '30000000-0000-4000-8000-000000000002',
          projectId: PROJECT_A,
          name: 'A target',
          host: '192.0.2.11',
          username: 'ubuntu',
          hostKeySha256: 'SHA256:test',
        },
      });

      await expect(
        db.jenkinsPipeline.create({
          data: {
            id: '40000000-0000-4000-8000-000000000001',
            projectId: PROJECT_B,
            name: 'deploy',
            folder: 'apps',
            targetId: '30000000-0000-4000-8000-000000000002',
            jenkinsCredentialId: '20000000-0000-4000-8000-000000000002',
          },
        }),
      ).rejects.toThrow(/Foreign key constraint violated/);
    } finally {
      await db.$disconnect();
    }
  });

  it('allows references inside the active project boundary', async () => {
    const db = await database();
    try {
      const credential = await db.credential.create({
        data: {
          id: '20000000-0000-4000-8000-000000000003',
          projectId: PROJECT_A,
          kind: 'ssh',
          name: 'A key',
          ciphertext: 'encrypted',
        },
      });
      const target = await db.vpsTarget.create({
        data: {
          id: '30000000-0000-4000-8000-000000000003',
          projectId: PROJECT_A,
          name: 'A target',
          host: '192.0.2.12',
          username: 'ubuntu',
          sshCredentialId: credential.id,
          hostKeySha256: 'SHA256:test',
        },
      });

      expect(target.projectId).toBe(PROJECT_A);
    } finally {
      await db.$disconnect();
    }
  });
});

describe('legacy project ownership migration', () => {
  it('creates one default project and preserves formerly global rows', async () => {
    const db = await legacyDatabase();
    const now = new Date().toISOString();
    try {
      await db.$executeRawUnsafe(
        `INSERT INTO "Credential"
          ("id","providerId","kind","name","ciphertext","metadata","createdAt","updatedAt")
         VALUES (?,?,?,?,?,?,?,?)`,
        'legacy-credential',
        null,
        'ssh',
        'Legacy key',
        'encrypted',
        '{}',
        now,
        now,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "Setting" ("key","value","updatedAt") VALUES (?,?,?)`,
        'settings',
        '{"appearance":{"theme":"system"}}',
        now,
      );
      await migrateSchema(db);

      expect(await migrateProjectOwnership(db)).toBe(true);
      const projects = await db.project.findMany();
      expect(projects).toHaveLength(1);
      const project = projects[0]!;
      expect(project.name).toBe('Default Project');
      const credentials = await db.credential.findMany();
      expect(credentials).toHaveLength(1);
      expect(credentials[0]?.projectId).toBe(project.id);
      expect(await db.setting.count({ where: { projectId: project.id } })).toBe(1);
      expect(await db.systemSetting.count()).toBe(1);

      expect(await migrateProjectOwnership(db)).toBe(false);
      expect(await db.project.count()).toBe(1);
      expect(await db.credential.count()).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });

  it('keeps a truly empty fresh installation without a project', async () => {
    const db = await legacyDatabase();
    try {
      await migrateSchema(db);
      expect(await migrateProjectOwnership(db)).toBe(true);
      expect(await db.project.count()).toBe(0);
      expect(await db.setting.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});
