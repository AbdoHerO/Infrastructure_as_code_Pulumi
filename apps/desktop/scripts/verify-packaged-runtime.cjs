const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const semver = require('semver');

function readPackage(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

function listPackages(nodeModules) {
  if (!existsSync(nodeModules)) return [];
  const packages = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.prisma') continue;
    const entryPath = join(nodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
        const scopedPath = join(entryPath, scoped.name);
        if (scoped.isDirectory() && existsSync(join(scopedPath, 'package.json'))) {
          packages.push(scopedPath);
        }
      }
    } else if (existsSync(join(entryPath, 'package.json'))) {
      packages.push(entryPath);
    }
  }
  return packages;
}

function findPackagedDependency(name, packageDirectory, appDirectory) {
  let current = packageDirectory;
  while (current.startsWith(appDirectory)) {
    const candidate = join(current, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (current === appDirectory) break;
    current = dirname(current);
  }
  return undefined;
}

function verifyDependencyClosure(appDirectory) {
  const queue = listPackages(join(appDirectory, 'node_modules'));
  const visited = new Set();
  const problems = [];

  while (queue.length > 0) {
    const packageDirectory = queue.pop();
    if (visited.has(packageDirectory)) continue;
    visited.add(packageDirectory);

    const metadata = readPackage(packageDirectory);
    for (const [name, requestedVersion] of Object.entries(metadata.dependencies ?? {})) {
      const dependency = findPackagedDependency(name, packageDirectory, appDirectory);
      if (!dependency) {
        problems.push(`${metadata.name}@${metadata.version} is missing ${name}`);
        continue;
      }

      const installedVersion = readPackage(dependency).version;
      const range = semver.validRange(requestedVersion);
      if (range && !semver.satisfies(installedVersion, range)) {
        problems.push(
          `${metadata.name}@${metadata.version} needs ${name}@${requestedVersion}, found ${installedVersion}`,
        );
      }
    }

    queue.push(...listPackages(join(packageDirectory, 'node_modules')));
  }

  if (problems.length > 0) {
    throw new Error(`Packaged dependency closure is invalid:\n${problems.join('\n')}`);
  }
  return visited.size;
}

function directoryContains(directory, marker) {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && directoryContains(path, marker)) return true;
    if (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      readFileSync(path, 'utf8').includes(marker)
    ) {
      return true;
    }
  }
  return false;
}

/** Electron-builder hook that prevents publishing an incomplete runtime. */
exports.default = function verifyPackagedRuntime(context) {
  const app = join(context.appOutDir, 'resources', 'app');
  const client = join(app, 'node_modules', '.prisma', 'client');
  const required = ['default.js', 'index.js', 'package.json', 'schema.prisma'];
  const missing = required.filter((file) => !existsSync(join(client, file)));
  const engines = existsSync(client)
    ? readdirSync(client).filter(
        (file) =>
          file.includes('query_engine') && (file.endsWith('.node') || file.endsWith('.wasm')),
      )
    : [];

  if (missing.length > 0 || engines.length === 0) {
    throw new Error(
      `Packaged Prisma runtime is incomplete (missing: ${missing.join(', ') || 'query engine'})`,
    );
  }

  const awsPackages = ['@aws-sdk/client-ec2', '@aws-sdk/client-sts', '@pulumi/aws'];
  const missingAwsPackages = awsPackages.filter(
    (name) => !existsSync(join(app, 'node_modules', ...name.split('/'), 'package.json')),
  );
  if (missingAwsPackages.length > 0) {
    throw new Error(`Packaged AWS runtime is incomplete: ${missingAwsPackages.join(', ')}`);
  }

  if (!directoryContains(join(app, 'out', 'main'), 'Connected to AWS account')) {
    throw new Error('Packaged main process does not contain the AWS provider implementation');
  }
  if (!directoryContains(join(app, 'out', 'main'), 'CloudForge firewall')) {
    throw new Error('Packaged main process does not contain the AWS Pulumi resource program');
  }

  const packageCount = verifyDependencyClosure(app);
  console.log(
    `  • verified packaged runtime  packages=${packageCount} prismaEngines=${engines.join(',')}`,
  );
};
