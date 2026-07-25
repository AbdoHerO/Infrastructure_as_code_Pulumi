import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from './client.js';
import { migrateProjectOwnership } from './project-ownership-migration.js';
import { ensureSchema } from './schema-bootstrap.js';

const PROJECT_A = '10000000-0000-4000-8000-000000000001';
const PROJECT_B = '10000000-0000-4000-8000-000000000002';
const created: string[] = [];

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'cloudforge-ownership-'));
  created.push(directory);
  const db = createPrismaClient(`file:${join(directory, 'test.db').replace(/\\/g, '/')}`);
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

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
