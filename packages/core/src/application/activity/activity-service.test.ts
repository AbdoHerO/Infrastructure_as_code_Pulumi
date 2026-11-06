import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityRecord, ActivityRepository } from '../ports/activity-repository.js';
import { ActivityService } from './activity-service.js';

const record = (id: string, type: string, message: string, createdAt: string): ActivityRecord => ({
  id,
  projectId: null,
  type,
  message,
  metadata: '{}',
  createdAt,
});

const records = [
  record('1', 'firewall.rules.updated', 'Updated the web firewall', '2026-03-03T00:00:00.000Z'),
  record('2', 'infrastructure.applied', 'Applied the plan', '2026-02-02T00:00:00.000Z'),
  record('3', 'firewall.rules.updated', 'Updated the db firewall', '2026-01-01T00:00:00.000Z'),
];

function fixture(): { service: ActivityService; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn((limit: number) => Promise.resolve(ok(records.slice(0, limit))));
  const repository = { create: vi.fn(), list } as unknown as ActivityRepository;
  return { service: new ActivityService(repository), list };
}

const ids = async (service: ActivityService, ...args: Parameters<ActivityService['list']>) => {
  const result = await service.list(...args);
  if (!result.ok) throw result.error;
  return result.value.map((item) => item.id);
};

describe('ActivityService.list', () => {
  it('reads only what was asked for when nothing filters it', async () => {
    const { service, list } = fixture();
    await expect(ids(service, 2)).resolves.toEqual(['1', '2']);
    expect(list).toHaveBeenCalledWith(2);
  });

  it('looks further back when filtering, then applies the limit', async () => {
    const { service, list } = fixture();
    await expect(ids(service, 1, { typePrefix: 'firewall.' })).resolves.toEqual(['1']);
    expect(list.mock.calls[0]![0]).toBeGreaterThan(1);
  });

  it('finds text in the message or the type, in any case', async () => {
    const { service } = fixture();
    await expect(ids(service, 10, { search: 'DB FIREWALL' })).resolves.toEqual(['3']);
    await expect(ids(service, 10, { search: 'infrastructure.' })).resolves.toEqual(['2']);
  });

  it('keeps only events since a date', async () => {
    const { service } = fixture();
    await expect(ids(service, 10, { since: '2026-02-01T00:00:00.000Z' })).resolves.toEqual([
      '1',
      '2',
    ]);
  });
});
