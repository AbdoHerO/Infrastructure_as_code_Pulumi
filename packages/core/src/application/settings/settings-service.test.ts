import { describe, expect, it } from 'vitest';
import { ok, type Result, type PersistenceError } from '@cloudforge/shared';
import type { SettingsRepository } from '../ports/settings-repository.js';
import { SettingsService } from './settings-service.js';

class MemorySettings implements SettingsRepository {
  value: string | null = null;
  get(): Promise<Result<string | null, PersistenceError>> {
    return Promise.resolve(ok(this.value));
  }
  set(_key: string, value: string): Promise<Result<void, PersistenceError>> {
    this.value = value;
    return Promise.resolve(ok(undefined));
  }
}

describe('SettingsService', () => {
  it('uses defaults for missing or malformed persisted settings', async () => {
    const repository = new MemorySettings();
    const service = new SettingsService(repository);
    expect((await service.get()).ok).toBe(true);
    repository.value = '{broken';
    const result = await service.get();
    expect(result.ok && result.value.logs.retentionDays).toBe(30);
  });

  it('merges sections and normalizes retention and region', async () => {
    const service = new SettingsService(new MemorySettings());
    const result = await service.update({
      deployment: { defaultRegion: '  eu-frankfurt-1  ', confirmDestructive: false },
      logs: { retentionDays: 999 },
    });
    expect(result.ok && result.value.deployment.defaultRegion).toBe('eu-frankfurt-1');
    expect(result.ok && result.value.logs.retentionDays).toBe(365);
    expect(result.ok && result.value.appearance.reducedMotion).toBe(false);
  });
});
