import type { PluginManifest } from '../../domain/plugin/plugin.js';

/**
 * The marketplace catalog of available plugins. In a full deployment this is
 * fetched from a registry; here it is a curated static list describing the
 * extension points the architecture supports.
 */
export const PLUGIN_CATALOG: readonly PluginManifest[] = [
  {
    id: 'provider-aws',
    name: 'Amazon Web Services',
    version: '0.1.0',
    kind: 'provider',
    description: 'Provision infrastructure on AWS.',
    author: 'CloudForge',
  },
  {
    id: 'provider-hetzner',
    name: 'Hetzner Cloud',
    version: '0.1.0',
    kind: 'provider',
    description: 'Provision infrastructure on Hetzner Cloud.',
    author: 'CloudForge',
  },
  {
    id: 'template-laravel',
    name: 'Laravel API',
    version: '0.1.0',
    kind: 'template',
    description: 'Deployment template for Laravel applications.',
    author: 'CloudForge',
  },
  {
    id: 'template-nestjs',
    name: 'NestJS',
    version: '0.1.0',
    kind: 'template',
    description: 'Deployment template for NestJS applications.',
    author: 'CloudForge',
  },
  {
    id: 'widget-costs',
    name: 'Cost Explorer',
    version: '0.1.0',
    kind: 'widget',
    description: 'A dashboard widget showing estimated monthly cost.',
    author: 'CloudForge',
  },
  {
    id: 'theme-nord',
    name: 'Nord Theme',
    version: '0.1.0',
    kind: 'theme',
    description: 'A cool, arctic colour theme.',
    author: 'Community',
  },
];
