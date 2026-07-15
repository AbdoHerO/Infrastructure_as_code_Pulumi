import { ok, type PersistenceError, type Result } from '@cloudforge/shared';
import type { SettingsRepository } from '../ports/settings-repository.js';
import { type AppSettings, DEFAULT_SETTINGS, type SettingsPatch } from './settings.js';

const SETTINGS_KEY = 'app.settings';

/**
 * Reads and writes the durable {@link AppSettings}, stored as a single JSON blob
 * and merged over the defaults so newly-added settings always have a value.
 */
export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}

  async get(): Promise<Result<AppSettings, PersistenceError>> {
    const stored = await this.repository.get(SETTINGS_KEY);
    if (!stored.ok) return stored;
    return ok(merge(DEFAULT_SETTINGS, parse(stored.value)));
  }

  async update(patch: SettingsPatch): Promise<Result<AppSettings, PersistenceError>> {
    const current = await this.get();
    if (!current.ok) return current;

    const next = normalize(merge(current.value, patch));
    const saved = await this.repository.set(SETTINGS_KEY, JSON.stringify(next));
    if (!saved.ok) return saved;
    return ok(next);
  }
}

function parse(raw: string | null): SettingsPatch {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Shallow-merge each settings section over the base. */
function merge(base: AppSettings, patch: SettingsPatch): AppSettings {
  return {
    appearance: { ...base.appearance, ...patch.appearance },
    deployment: { ...base.deployment, ...patch.deployment },
    logs: { ...base.logs, ...patch.logs },
    updates: { ...base.updates, ...patch.updates },
    ssl: { ...base.ssl, ...patch.ssl },
    cloudflare: { ...base.cloudflare, ...patch.cloudflare },
  };
}

function normalize(settings: AppSettings): AppSettings {
  return {
    ...settings,
    deployment: {
      ...settings.deployment,
      defaultRegion: settings.deployment.defaultRegion.trim().slice(0, 100),
    },
    logs: {
      retentionDays: Math.min(365, Math.max(1, Math.trunc(settings.logs.retentionDays) || 30)),
    },
    ssl: {
      ...settings.ssl,
      renewBeforeDays: Math.min(90, Math.max(1, Math.trunc(settings.ssl.renewBeforeDays) || 30)),
      checkIntervalHours: Math.min(
        168,
        Math.max(1, Math.trunc(settings.ssl.checkIntervalHours) || 24),
      ),
      managed: settings.ssl.managed.slice(0, 500),
    },
    cloudflare: {
      ...settings.cloudflare,
      defaultCredentialId: settings.cloudflare.defaultCredentialId.trim().slice(0, 100),
      defaultZoneId: settings.cloudflare.defaultZoneId.trim().slice(0, 100),
      defaultTtl:
        settings.cloudflare.defaultTtl === 1
          ? 1
          : Math.min(86400, Math.max(60, Math.trunc(settings.cloudflare.defaultTtl) || 300)),
      propagationTimeoutSeconds: Math.min(
        3600,
        Math.max(30, Math.trunc(settings.cloudflare.propagationTimeoutSeconds) || 300),
      ),
      autoRefreshMinutes: Math.min(
        1440,
        Math.max(1, Math.trunc(settings.cloudflare.autoRefreshMinutes) || 15),
      ),
      cacheTtl: Math.min(31536000, Math.max(0, Math.trunc(settings.cloudflare.cacheTtl) || 0)),
    },
  };
}
