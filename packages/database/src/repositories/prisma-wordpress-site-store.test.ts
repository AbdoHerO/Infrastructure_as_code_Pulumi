import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryProjectContext,
  type StackRecord,
  type WordPressSiteRecord,
} from '@cloudforge/core';
import { createPrismaClient, type Db } from '../client.js';
import { ensureSchema } from '../schema-bootstrap.js';
import { PrismaProjectConfigurationCloner } from './prisma-project-configuration-cloner.js';
import { PrismaStackStore } from './prisma-stack-store.js';
import { PrismaWordPressSiteStore } from './prisma-wordpress-site-store.js';

const PROJECT_A = '10000000-0000-4000-8000-0000000000a1';
const PROJECT_B = '10000000-0000-4000-8000-0000000000b2';
const fixtures: { directory: string; db: Db }[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.db.$disconnect();
    await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function database(): Promise<Db> {
  const directory = await mkdtemp(join(tmpdir(), 'cloudforge-wordpress-'));
  const db = createPrismaClient(`file:${join(directory, 'test.db').replace(/\\/g, '/')}`);
  fixtures.push({ directory, db });
  await db.$connect();
  await ensureSchema(db);
  await db.project.createMany({
    data: [
      { id: PROJECT_A, name: 'A', environment: 'development', region: 'test' },
      { id: PROJECT_B, name: 'B', environment: 'development', region: 'test' },
    ],
  });
  return db;
}

function site(id: string, domain: string): WordPressSiteRecord {
  return {
    id,
    targetId: 'target-1',
    domain,
    project: `cloudforge-wp-${domain.replace(/\./g, '-')}`,
    siteTitle: 'Blog',
    adminUser: 'alex',
    adminEmail: 'alex@example.com',
    hostPort: 8300,
    credentialId: 'credential-1',
    cloudflareCredentialId: null,
    cloudflareZoneId: null,
    https: true,
    certificateEmail: 'alex@example.com',
    status: 'running',
    wordpressVersion: '6.9',
    warnings: [],
    lastError: null,
    createdAt: '2026-10-26T10:00:00.000Z',
    updatedAt: '2026-10-26T10:00:00.000Z',
  };
}

describe('PrismaWordPressSiteStore', () => {
  it('saves, replaces and removes sites in the active project only', async () => {
    const db = await database();
    const contextA = new InMemoryProjectContext();
    contextA.activate(PROJECT_A);
    const contextB = new InMemoryProjectContext();
    contextB.activate(PROJECT_B);
    const storeA = new PrismaWordPressSiteStore(db, contextA);
    const storeB = new PrismaWordPressSiteStore(db, contextB);

    await storeA.save(site('a1', 'blog.example.com'));
    await storeA.save(site('a2', 'shop.example.com'));
    await storeA.save({ ...site('a1', 'blog.example.com'), status: 'failed' });
    await storeB.save(site('b1', 'other.example.com'));

    const listA = await storeA.list();
    expect(listA.ok && listA.value.map((item) => [item.id, item.status])).toEqual([
      ['a2', 'running'],
      ['a1', 'failed'],
    ]);
    await storeA.remove('a2');
    const afterRemove = await storeA.list();
    expect(afterRemove.ok && afterRemove.value.map((item) => item.id)).toEqual(['a1']);
    const listB = await storeB.list();
    expect(listB.ok && listB.value.map((item) => item.id)).toEqual(['b1']);
  });

  it('is not copied when a project is duplicated: the copy deployed nothing', async () => {
    const db = await database();
    await db.setting.createMany({
      data: [
        { projectId: PROJECT_A, key: 'wordpress:sites', value: '[{"id":"site"}]' },
        { projectId: PROJECT_A, key: 'stacks:list', value: '[{"id":"stack"}]' },
        { projectId: PROJECT_A, key: 'app.settings', value: '{"kept":true}' },
      ],
    });
    const cloned = await new PrismaProjectConfigurationCloner(db).clone(PROJECT_A, PROJECT_B);
    expect(cloned.ok).toBe(true);
    const copied = await db.setting.findMany({
      where: { projectId: PROJECT_B },
      select: { key: true },
    });
    expect(copied.map((item) => item.key)).toEqual(['app.settings']);
  });

  it('keeps Docker stacks in their own list, separate from WordPress sites', async () => {
    const db = await database();
    const context = new InMemoryProjectContext();
    context.activate(PROJECT_A);
    const stacks = new PrismaStackStore(db, context);
    await stacks.save({ id: 'stack-1', name: 'rustfs' } as StackRecord);
    await new PrismaWordPressSiteStore(db, context).save(site('a1', 'blog.example.com'));

    const listed = await stacks.list();
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual(['stack-1']);
  });

  it('starts empty', async () => {
    const db = await database();
    const context = new InMemoryProjectContext();
    context.activate(PROJECT_A);
    const listed = await new PrismaWordPressSiteStore(db, context).list();
    expect(listed.ok && listed.value).toEqual([]);
  });
});
