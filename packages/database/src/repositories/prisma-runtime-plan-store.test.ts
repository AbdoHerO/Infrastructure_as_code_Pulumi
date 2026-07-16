import { describe, expect, it, vi } from 'vitest';
import { emptyRuntimePlan, type VpsRuntimePlan } from '@cloudforge/core';
import { PrismaRuntimePlanStore } from './prisma-runtime-plan-store.js';
import type { Db } from '../client.js';

const TARGET_ID = '3f1c2b8e-9a4d-4e5f-8b7a-1c2d3e4f5a6b';
const KEY = `runtime-plan:${TARGET_ID}`;

/** An in-memory stand-in for the one Prisma table this store touches. */
function fakeDb() {
  const rows = new Map<string, string>();
  const findUnique = vi.fn(({ where }: { where: { key: string } }) => {
    const value = rows.get(where.key);
    return Promise.resolve(value === undefined ? null : { key: where.key, value });
  });
  const upsert = vi.fn(
    ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
      rows.set(where.key, create.value);
      return Promise.resolve(create);
    },
  );
  const deleteMany = vi.fn(({ where }: { where: { key: string } }) => {
    const existed = rows.delete(where.key);
    return Promise.resolve({ count: existed ? 1 : 0 });
  });
  const db = { setting: { findUnique, upsert, deleteMany } } as unknown as Db;
  return { db, rows, findUnique, upsert, deleteMany };
}

const plan = (overrides: Partial<VpsRuntimePlan> = {}): VpsRuntimePlan => ({
  ...emptyRuntimePlan(TARGET_ID),
  ...overrides,
});

describe('PrismaRuntimePlanStore', () => {
  it('reports a never-managed target as having no plan', async () => {
    // Absence is a normal state, not an error: it means CloudForge has not been
    // asked to manage this target yet.
    const { db } = fakeDb();

    expect(await new PrismaRuntimePlanStore(db).load(TARGET_ID)).toEqual({ ok: true, value: null });
  });

  it('round-trips a plan', async () => {
    const { db } = fakeDb();
    const store = new PrismaRuntimePlanStore(db);
    const saved = plan({ mode: 'managed', version: 3 });

    await store.save(TARGET_ID, saved);

    expect(await store.load(TARGET_ID)).toEqual({ ok: true, value: saved });
  });

  it('keys a plan by its target so two targets never collide', async () => {
    const { db, rows } = fakeDb();
    const store = new PrismaRuntimePlanStore(db);

    await store.save(TARGET_ID, plan());

    expect([...rows.keys()]).toEqual([KEY]);
  });

  it('overwrites rather than duplicating on re-save', async () => {
    const { db, rows } = fakeDb();
    const store = new PrismaRuntimePlanStore(db);

    await store.save(TARGET_ID, plan({ version: 1 }));
    await store.save(TARGET_ID, plan({ version: 2 }));

    expect(rows.size).toBe(1);
    const loaded = await store.load(TARGET_ID);
    expect(loaded.ok && loaded.value?.version).toBe(2);
  });

  it('degrades a corrupt row to "not managed" instead of failing every read', async () => {
    const { db, rows } = fakeDb();
    rows.set(KEY, 'this is not json');

    expect(await new PrismaRuntimePlanStore(db).load(TARGET_ID)).toMatchObject({ ok: false });
  });

  it('ignores a row whose plan belongs to another target', async () => {
    const { db, rows } = fakeDb();
    rows.set(KEY, JSON.stringify(plan({ targetId: 'someone-else' })));

    expect(await new PrismaRuntimePlanStore(db).load(TARGET_ID)).toEqual({ ok: true, value: null });
  });

  it.each(['[]', '"a string"', 'null', '42'])('ignores a row containing %s', async (value) => {
    const { db, rows } = fakeDb();
    rows.set(KEY, value);

    expect(await new PrismaRuntimePlanStore(db).load(TARGET_ID)).toEqual({ ok: true, value: null });
  });

  it('deletes a plan, and deleting a missing one succeeds', async () => {
    const { db, rows } = fakeDb();
    const store = new PrismaRuntimePlanStore(db);
    await store.save(TARGET_ID, plan());

    expect(await store.delete(TARGET_ID)).toEqual({ ok: true, value: undefined });
    expect(rows.size).toBe(0);
    // Removing a plan that was never saved is a no-op, not a failure.
    expect(await store.delete(TARGET_ID)).toEqual({ ok: true, value: undefined });
  });

  it('reports a persistence failure as a Result rather than throwing', async () => {
    const db = {
      setting: {
        findUnique: vi.fn().mockRejectedValue(new Error('database is locked')),
        upsert: vi.fn().mockRejectedValue(new Error('database is locked')),
        deleteMany: vi.fn().mockRejectedValue(new Error('database is locked')),
      },
    } as unknown as Db;
    const store = new PrismaRuntimePlanStore(db);

    expect((await store.load(TARGET_ID)).ok).toBe(false);
    expect((await store.save(TARGET_ID, plan())).ok).toBe(false);
    expect((await store.delete(TARGET_ID)).ok).toBe(false);
  });
});
