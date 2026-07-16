import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve from this file, not the working directory: the suite runs both from
// the package (`pnpm test`) and from the repository root (`pnpm test:coverage`).
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

const SOURCE_ROOTS = [
  'apps/desktop/src',
  'packages/core/src',
  'packages/database/src',
  'packages/deployment/src',
  'packages/providers/src',
  'packages/pulumi/src',
  'packages/service-providers/src',
  'packages/shared/src',
  'packages/ui/src',
];

/**
 * Values belonging to one operator's own deployment rather than to the product.
 *
 * `ansible-playbooks.test.ts` has long asserted this over playbooks alone; the
 * same rule applies to every line CloudForge ships, and a placeholder naming a
 * real customer domain had already reached the Jenkins page.
 */
const PRIVATE_VALUES = [
  { pattern: /hanout\s*plus|hanoutplus/i, label: 'a specific customer or project name' },
  { pattern: /\b51\.170\.132\.\d{1,3}\b/, label: "a specific server's public IP" },
  { pattern: /ABDOwahna/i, label: 'a personal identifier' },
  { pattern: /cloudforge_hanoutplus_rsa/i, label: 'a personal SSH key file name' },
];

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    // Test fixtures may legitimately name a value in order to ban it.
    return /(?<!\.test)\.(?:ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe('product neutrality', () => {
  const files = SOURCE_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root)));

  it('scans the shipped source of every workspace package', () => {
    // Guards the guard: a broken path would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(200);
  });

  it.each(PRIVATE_VALUES)('ships no source containing $label', ({ pattern }) => {
    const violations = files
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(repoRoot.length).replaceAll('\\', '/'));

    expect(violations).toEqual([]);
  });
});
