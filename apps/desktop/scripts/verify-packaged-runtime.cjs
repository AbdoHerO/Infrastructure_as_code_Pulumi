const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** Electron-builder hook that prevents publishing an installer without Prisma. */
exports.default = function verifyPackagedRuntime(context) {
  const client = join(context.appOutDir, 'resources', 'app', 'node_modules', '.prisma', 'client');
  const required = ['default.js', 'index.js', 'package.json', 'schema.prisma'];
  const missing = required.filter((file) => !existsSync(join(client, file)));
  const engines = existsSync(client)
    ? readdirSync(client).filter(
        (file) => file.includes('query_engine') && (file.endsWith('.node') || file.endsWith('.wasm')),
      )
    : [];

  if (missing.length > 0 || engines.length === 0) {
    throw new Error(
      `Packaged Prisma runtime is incomplete (missing: ${missing.join(', ') || 'query engine'})`,
    );
  }

  console.log(`  • verified packaged Prisma runtime  engines=${engines.join(',')}`);
};
