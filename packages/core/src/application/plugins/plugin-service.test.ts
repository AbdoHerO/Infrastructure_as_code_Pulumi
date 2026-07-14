import { describe, expect, it } from 'vitest';
import { ok, type PersistenceError, type Result } from '@cloudforge/shared';
import type { InstalledPluginRecord, PluginRepository } from '../ports/plugin-repository.js';
import { PluginService } from './plugin-service.js';

class MemoryPlugins implements PluginRepository {
  records = new Map<string, boolean>();
  listInstalled(): Promise<Result<InstalledPluginRecord[], PersistenceError>> {
    return Promise.resolve(ok([...this.records].map(([id, enabled]) => ({ id, enabled }))));
  }
  upsert(id: string, enabled: boolean): Promise<Result<void, PersistenceError>> {
    this.records.set(id, enabled);
    return Promise.resolve(ok(undefined));
  }
  remove(id: string): Promise<Result<void, PersistenceError>> {
    this.records.delete(id);
    return Promise.resolve(ok(undefined));
  }
}

describe('PluginService', () => {
  it('installs, disables and uninstalls a trusted declarative extension', async () => {
    const repository = new MemoryPlugins();
    const service = new PluginService(repository);
    expect((await service.list()).ok).toBe(true);
    expect((await service.install('theme-nord')).ok).toBe(true);
    const active = await service.active();
    expect(active.ok && active.value[0]?.contribution).toBe('theme:nord');
    expect((await service.setEnabled('theme-nord', false)).ok).toBe(true);
    const disabled = await service.active();
    expect(disabled.ok && disabled.value).toEqual([]);
    expect((await service.uninstall('theme-nord')).ok).toBe(true);
  });

  it('rejects unknown extension identifiers', async () => {
    const service = new PluginService(new MemoryPlugins());
    expect((await service.install('../untrusted')).ok).toBe(false);
    expect((await service.setEnabled('missing', true)).ok).toBe(false);
  });
});
