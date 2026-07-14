import { err, NotFoundError, ok, type PersistenceError, type Result } from '@cloudforge/shared';
import type { PluginKind, PluginManifest } from '../../domain/plugin/plugin.js';
import type { PluginRepository } from '../ports/plugin-repository.js';
import { PLUGIN_CATALOG } from './plugin-catalog.js';

/** A catalog entry combined with its local installation state. */
export interface PluginListItem {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly description: string;
  readonly author: string;
  readonly installed: boolean;
  readonly enabled: boolean;
}

/** Errors the plugin use-cases can surface. */
export type PluginServiceError = PersistenceError | NotFoundError;

/**
 * Merges the marketplace catalog with locally-persisted installation state and
 * manages install / enable / uninstall. Extensions are declarative and bundled;
 * arbitrary third-party code is never loaded into the Electron process.
 */
export class PluginService {
  constructor(private readonly plugins: PluginRepository) {}

  async list(): Promise<Result<PluginListItem[], PersistenceError>> {
    const installed = await this.plugins.listInstalled();
    if (!installed.ok) return installed;
    const state = new Map(installed.value.map((p) => [p.id, p.enabled]));

    return ok(
      PLUGIN_CATALOG.map((manifest) => ({
        ...manifest,
        installed: state.has(manifest.id),
        enabled: state.get(manifest.id) ?? false,
      })),
    );
  }

  async install(id: string): Promise<Result<void, PluginServiceError>> {
    const manifest = findManifest(id);
    if (!manifest) return err(new NotFoundError(`Unknown plugin: ${id}`));
    return this.plugins.upsert(id, true, JSON.stringify(manifest));
  }

  async active(): Promise<Result<PluginManifest[], PersistenceError>> {
    const installed = await this.plugins.listInstalled();
    if (!installed.ok) return installed;
    const enabled = new Set(
      installed.value.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
    );
    return ok(PLUGIN_CATALOG.filter((manifest) => enabled.has(manifest.id)));
  }

  async setEnabled(id: string, enabled: boolean): Promise<Result<void, PluginServiceError>> {
    const manifest = findManifest(id);
    if (!manifest) return err(new NotFoundError(`Unknown plugin: ${id}`));
    return this.plugins.upsert(id, enabled, JSON.stringify(manifest));
  }

  uninstall(id: string): Promise<Result<void, PersistenceError>> {
    return this.plugins.remove(id);
  }
}

function findManifest(id: string): PluginManifest | undefined {
  return PLUGIN_CATALOG.find((manifest) => manifest.id === id);
}
