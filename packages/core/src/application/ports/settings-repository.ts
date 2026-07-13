import type { PersistenceError, Result } from '@cloudforge/shared';

/** Persistence port for simple key/value settings. */
export interface SettingsRepository {
  get(key: string): Promise<Result<string | null, PersistenceError>>;
  set(key: string, value: string): Promise<Result<void, PersistenceError>>;
}
