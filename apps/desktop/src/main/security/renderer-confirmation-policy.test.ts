import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve from this file, not the working directory: the suite runs both from
// the package (`pnpm test`) and from the repository root (`pnpm test:coverage`).
const rendererRoot = fileURLToPath(new URL('../../renderer/src', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(entry)
        ? [path]
        : [];
  });
}

describe('renderer confirmation policy', () => {
  it('never uses blocking browser prompt or confirm APIs in Electron', () => {
    const violations = sourceFiles(rendererRoot).filter((path) => {
      const source = readFileSync(path, 'utf8');
      return (
        /\b(?:window|globalThis)\.(?:confirm|prompt)\s*\(/.test(source) ||
        /(?<![\w.])prompt\s*\(/.test(source)
      );
    });

    expect(violations).toEqual([]);
  });

  it('keeps destructive feature surfaces connected to an in-app confirmation dialog', () => {
    const guardedPages = [
      'features/secrets/SecretsPage.tsx',
      'features/projects/ProjectsPage.tsx',
      'features/templates/TemplatesPage.tsx',
      'features/marketplace/MarketplacePage.tsx',
      'features/containers/ContainersPage.tsx',
      'features/vps-runtime/VpsRuntimePage.tsx',
      'features/deployments/DeploymentsPage.tsx',
      'features/ansible/AnsiblePage.tsx',
      'features/nginx/NginxPage.tsx',
      'features/firewall/FirewallPage.tsx',
      'features/ssl/SslPage.tsx',
      'features/cloudflare/CloudflarePage.tsx',
      'features/infrastructure/InfrastructurePage.tsx',
      'features/settings/SettingsPage.tsx',
      'features/updates/UpdatesPage.tsx',
      'features/providers/ProviderCard.tsx',
    ];

    for (const relative of guardedPages) {
      const source = readFileSync(join(rendererRoot, relative), 'utf8');
      expect(source, relative).toMatch(/useConfirmation|NameConfirmationDialog/);
    }
  });
});
