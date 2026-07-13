import type { PersistenceError, Result } from '@cloudforge/shared';

/** Installed-plugin state persisted locally. */
export interface InstalledPluginRecord {
  readonly id: string;
  readonly enabled: boolean;
}

/** Persistence port for installed plugins. */
export interface PluginRepository {
  listInstalled(): Promise<Result<InstalledPluginRecord[], PersistenceError>>;
  upsert(
    id: string,
    enabled: boolean,
    manifestJson: string,
  ): Promise<Result<void, PersistenceError>>;
  remove(id: string): Promise<Result<void, PersistenceError>>;
}
