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
    expect(result.ok && result.value.updates.checkOnStartup).toBe(true);
  });

  it('merges sections and normalizes retention and region', async () => {
    const service = new SettingsService(new MemorySettings());
    const result = await service.update({
      deployment: { defaultRegion: '  eu-frankfurt-1  ', confirmDestructive: false },
      logs: { retentionDays: 999 },
      updates: { checkOnStartup: false, autoDownload: true },
    });
    expect(result.ok && result.value.deployment.defaultRegion).toBe('eu-frankfurt-1');
    expect(result.ok && result.value.logs.retentionDays).toBe(365);
    expect(result.ok && result.value.appearance.reducedMotion).toBe(false);
    expect(result.ok && result.value.updates).toEqual({
      checkOnStartup: false,
      autoDownload: true,
    });
  });

  it('merges and bounds Cloudflare automation preferences', async () => {
    const service = new SettingsService(new MemorySettings());
    const result = await service.update({
      cloudflare: {
        defaultCredentialId: ' credential-1 ',
        defaultZoneId: ' zone-1 ',
        defaultTtl: 10,
        propagationTimeoutSeconds: 9_999,
        autoRefreshMinutes: 0,
      },
    });
    expect(result.ok && result.value.cloudflare.defaultCredentialId).toBe('credential-1');
    expect(result.ok && result.value.cloudflare.defaultZoneId).toBe('zone-1');
    expect(result.ok && result.value.cloudflare.defaultTtl).toBe(60);
    expect(result.ok && result.value.cloudflare.propagationTimeoutSeconds).toBe(3600);
    expect(result.ok && result.value.cloudflare.autoRefreshMinutes).toBe(15);
    expect(result.ok && result.value.cloudflare.defaultProxy).toBe(true);
  });
});
