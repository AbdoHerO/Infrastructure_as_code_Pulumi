const { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const { dirname, join, relative, resolve, sep } = require('node:path');

const appDirectory = resolve(__dirname, '..');
const workspaceDirectory = resolve(appDirectory, '../..');
const workspaceNodeModules = join(workspaceDirectory, 'node_modules');
const destinationNodeModules = join(appDirectory, '.packaged-runtime', 'node_modules');
const copiedPackages = new Set();

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

rmSync(resolve(appDirectory, '.packaged-runtime'), {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
});
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
