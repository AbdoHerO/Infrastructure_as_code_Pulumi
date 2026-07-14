import type { PluginManifest } from '../../domain/plugin/plugin.js';

/**
 * Trusted, declarative extensions shipped with CloudForge. No downloaded
 * JavaScript is executed: application code interprets each contribution.
 */
export const PLUGIN_CATALOG: readonly PluginManifest[] = [
  {
    id: 'theme-nord',
    name: 'Nord Theme',
    version: '0.1.0',
    kind: 'theme',
    description: 'A cool, arctic colour theme.',
    author: 'CloudForge',
    contribution: 'theme:nord',
  },
];
