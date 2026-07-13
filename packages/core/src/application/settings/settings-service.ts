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

    const next = merge(current.value, patch);
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
    telemetry: { ...base.telemetry, ...patch.telemetry },
  };
}
