import { readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Usage: corepack pnpm release:version <semver>, for example 0.2.0');
}

for (const path of ['package.json', 'apps/desktop/package.json']) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = version;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

process.stdout.write(`CloudForge release version set to ${version}\n`);
