import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type Db } from './client.js';
import { ensureSchema } from './schema-bootstrap.js';
import {
  importProjectSnapshot,
  isolateProjectSnapshot,
  restoreProjectSnapshot,
} from './project-snapshot.js';

const PROJECT_A = '10000000-0000-4000-8000-000000000001';
const PROJECT_B = '10000000-0000-4000-8000-000000000002';
const created: { directory: string; db: Db }[] = [];

async function database(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `cloudforge-${name}-`));
  const db = createPrismaClient(`file:${join(directory, 'test.db').replace(/\\/g, '/')}`);
  created.push({ directory, db });
  await db.$connect();
  await ensureSchema(db);
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

async function seed(db: Awaited<ReturnType<typeof database>>): Promise<void> {
  await db.project.createMany({
    data: [
      {
        id: PROJECT_A,
        name: 'A',
        environment: 'development',
        region: 'eu-test-1',
        passkeyHash: 'source-hash',
        passkeySalt: 'source-salt',
      },
      {
        id: PROJECT_B,
        name: 'B',
        environment: 'development',
        region: 'eu-test-1',
      },
    ],
  });
  await db.credential.createMany({
    data: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        projectId: PROJECT_A,
        kind: 'github',
        name: 'A secret',
        ciphertext: 'encrypted-a',
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        projectId: PROJECT_B,
        kind: 'github',
        name: 'B secret',
        ciphertext: 'encrypted-b',
      },
    ],
  });
  await db.setting.create({
    data: { projectId: PROJECT_A, key: 'runtime-plan:test', value: '{"mode":"legacy"}' },
  });
  await db.systemSetting.create({ data: { key: 'updates', value: '{"enabled":true}' } });
}

describe('project snapshots', () => {
  it('removes every other project and device setting from a backup', async () => {
    const db = await database('isolate');
    try {
      await seed(db);
      await isolateProjectSnapshot(db, PROJECT_A);

      expect(await db.project.findMany({ select: { id: true } })).toEqual([{ id: PROJECT_A }]);
      expect(await db.credential.findMany({ select: { name: true } })).toEqual([
        { name: 'A secret' },
      ]);
      expect(await db.systemSetting.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });

  it('replaces only the destination project and preserves its passkey', async () => {
    const source = await database('source');
    const target = await database('target');
    try {
      await seed(source);
      await isolateProjectSnapshot(source, PROJECT_A);
      await seed(target);
      await target.project.update({
        where: { id: PROJECT_A },
        data: { name: 'Changed', passkeyHash: 'current-hash', passkeySalt: 'current-salt' },
      });

      await restoreProjectSnapshot(target, source, PROJECT_A);

      const restored = await target.project.findUniqueOrThrow({ where: { id: PROJECT_A } });
      expect(restored.name).toBe('A');
      expect(restored.passkeyHash).toBe('current-hash');
      expect(restored.passkeySalt).toBe('current-salt');
      expect(await target.project.findUnique({ where: { id: PROJECT_B } })).not.toBeNull();
      expect(
        await target.credential.findMany({
          where: { projectId: PROJECT_B },
          select: { name: true },
        }),
      ).toEqual([{ name: 'B secret' }]);
      expect(
        await target.setting.findUnique({
          where: { projectId_key: { projectId: PROJECT_A, key: 'runtime-plan:test' } },
        }),
      ).not.toBeNull();
    } finally {
      await Promise.all([source.$disconnect(), target.$disconnect()]);
    }
  });

  it('imports an isolated project with a new passkey and destination ciphertexts', async () => {
    const source = await database('import-source');
    const target = await database('import-target');
    try {
      await seed(source);
      await isolateProjectSnapshot(source, PROJECT_A);
      await importProjectSnapshot(
        target,
        source,
        PROJECT_A,
        { hash: 'destination-hash', salt: 'destination-salt', version: 1 },
        {
          credentials: {
            '20000000-0000-4000-8000-000000000001': 'destination-ciphertext',
          },
          sshKeys: {},
          secrets: {},
        },
      );

      const imported = await target.project.findUniqueOrThrow({ where: { id: PROJECT_A } });
      expect(imported.name).toBe('A');
      expect(imported.passkeyHash).toBe('destination-hash');
      expect(imported.passkeySalt).toBe('destination-salt');
      expect(imported.lastOpenedAt).toBeNull();
      expect(
        await target.credential.findUniqueOrThrow({
          where: { id: '20000000-0000-4000-8000-000000000001' },
        }),
      ).toMatchObject({ ciphertext: 'destination-ciphertext', projectId: PROJECT_A });
      expect(await target.systemSetting.count()).toBe(0);
    } finally {
      await Promise.all([source.$disconnect(), target.$disconnect()]);
    }
  });

  it('refuses to merge an imported snapshot into an existing project', async () => {
    const source = await database('collision-source');
    const target = await database('collision-target');
    try {
      await seed(source);
      await isolateProjectSnapshot(source, PROJECT_A);
      await target.project.create({
        data: { id: PROJECT_A, name: 'Existing', environment: 'production', region: 'eu-test-1' },
      });

      await expect(
        importProjectSnapshot(
          target,
          source,
          PROJECT_A,
          { hash: 'hash', salt: 'salt', version: 1 },
          {
            credentials: { '20000000-0000-4000-8000-000000000001': 'wrapped' },
            sshKeys: {},
            secrets: {},
          },
        ),
      ).rejects.toThrow('already exists');
      expect((await target.project.findUniqueOrThrow({ where: { id: PROJECT_A } })).name).toBe(
        'Existing',
      );
    } finally {
      await Promise.all([source.$disconnect(), target.$disconnect()]);
    }
  });
});
