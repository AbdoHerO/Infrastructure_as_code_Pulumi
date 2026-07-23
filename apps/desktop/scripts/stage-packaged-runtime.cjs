const { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const { dirname, join, relative, resolve, sep } = require('node:path');

const appDirectory = resolve(__dirname, '..');
const workspaceDirectory = resolve(appDirectory, '../..');
const workspaceNodeModules = join(workspaceDirectory, 'node_modules');
const destinationNodeModules = join(appDirectory, '.packaged-runtime', 'node_modules');
const copiedPackages = new Set();
const removableDirectory = resolve(appDirectory, '.packaged-runtime');

function removeDirectoryWithRetries(directory) {
  const resolvedDirectory = resolve(directory);
  const relativeToApp = relative(appDirectory, resolvedDirectory);
  if (relativeToApp === '' || relativeToApp === '..' || relativeToApp.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to remove a directory outside the desktop app: ${resolvedDirectory}`);
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(resolvedDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      const retryable =
        error && typeof error === 'object' && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code);
      if (!retryable || attempt === 9) throw error;

      // Antivirus and file indexers can briefly retain handles after Pulumi
      // packages are copied. Keep the retry bounded and synchronous because
      // this staging script must finish before electron-builder starts.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (attempt + 1));
    }
  }
}

function readPackage(packageDirectory) {
  return JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
}

function findDependency(name, fromDirectory) {
  let current = fromDirectory;
  while (true) {
    const candidate = join(current, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (current === workspaceDirectory) break;

    const parent = dirname(current);
    if (parent === current || !parent.startsWith(workspaceDirectory)) break;
    current = parent;
  }
  return undefined;
}

function destinationFor(name, sourceDirectory) {
  const relativeToNodeModules = relative(workspaceNodeModules, sourceDirectory);
  if (
    relativeToNodeModules !== '' &&
    relativeToNodeModules !== '..' &&
    !relativeToNodeModules.startsWith(`..${sep}`)
  ) {
    return join(destinationNodeModules, relativeToNodeModules);
  }

  // Workspace packages are linked outside node_modules during development but
  // must be real package directories in the installed application.
  return join(destinationNodeModules, ...name.split('/'));
}

function copyPackage(name, sourceDirectory) {
  const source = realpathSync(sourceDirectory);
  const destination = destinationFor(name, sourceDirectory);
  const identity = `${source}\0${destination}`;
  if (copiedPackages.has(identity)) return;
  copiedPackages.add(identity);

  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => {
      const nestedPath = relative(source, path);
      return nestedPath !== 'node_modules' && !nestedPath.startsWith(`node_modules${sep}`);
    },
  });

  const metadata = readPackage(source);
  const required = metadata.dependencies ?? {};
  const optional = metadata.optionalDependencies ?? {};
  for (const dependencyName of new Set([...Object.keys(required), ...Object.keys(optional)])) {
    const dependencySource = findDependency(dependencyName, source);
    if (!dependencySource) {
      if (Object.hasOwn(optional, dependencyName)) continue;
      throw new Error(`${metadata.name} requires missing production dependency ${dependencyName}`);
    }
    copyPackage(dependencyName, dependencySource);
  }
}

removeDirectoryWithRetries(removableDirectory);
mkdirSync(destinationNodeModules, { recursive: true });

const appPackage = readPackage(appDirectory);
for (const dependencyName of Object.keys(appPackage.dependencies ?? {})) {
  const source = findDependency(dependencyName, appDirectory);
  if (!source) throw new Error(`Desktop runtime dependency is missing: ${dependencyName}`);
  copyPackage(dependencyName, source);
}

// Prisma generates this package outside its declared dependency graph.
const prismaSource = join(workspaceNodeModules, '.prisma', 'client');
if (!existsSync(join(prismaSource, 'default.js'))) {
  throw new Error('Generated Prisma client is missing. Run the database prisma:generate script.');
}
cpSync(prismaSource, join(destinationNodeModules, '.prisma', 'client'), {
  recursive: true,
  filter: (path) => !/\.tmp\d*$/.test(path),
});

console.log(`Staged ${copiedPackages.size} production packages and the Prisma client`);
