const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');

const source = resolve(__dirname, '../../../node_modules/.prisma/client');
const destination = resolve(__dirname, '../node_modules/.prisma/client');

if (!existsSync(source)) {
  throw new Error('Generated Prisma client is missing. Run the database prisma:generate script.');
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, {
  recursive: true,
  filter: (path) => !/\.tmp\d*$/.test(path),
});

console.log(`Staged generated Prisma runtime at ${destination}`);
