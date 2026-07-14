import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * Inject a strict Content-Security-Policy <meta> into the PRODUCTION HTML only.
 * In development the meta is omitted so Vite's React-refresh inline preamble can
 * run; the main process applies a relaxed dev CSP via response headers instead.
 */
function productionCspMeta(): Plugin {
  const meta =
    '<meta http-equiv="Content-Security-Policy" content="' +
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws:;" +
    '" />';
  return {
    name: 'cloudforge:production-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('</head>', `  ${meta}\n  </head>`);
    },
  };
}

/**
 * Workspace packages are published as TypeScript source, so we alias them to
 * their entry files and let Vite/esbuild transpile them as first-party code.
 */
const workspaceAliases = {
  '@cloudforge/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
  '@cloudforge/core': resolve(__dirname, '../../packages/core/src/index.ts'),
  '@cloudforge/database': resolve(__dirname, '../../packages/database/src/index.ts'),
  '@cloudforge/deployment': resolve(__dirname, '../../packages/deployment/src/index.ts'),
  '@cloudforge/providers': resolve(__dirname, '../../packages/providers/src/index.ts'),
  '@cloudforge/pulumi': resolve(__dirname, '../../packages/pulumi/src/index.ts'),
  '@cloudforge/ui': resolve(__dirname, '../../packages/ui/src/index.ts'),
};

/**
 * Workspace packages must be BUNDLED into the main/preload output (they ship as
 * TypeScript source and cannot be `require`d at runtime). Everything else —
 * notably `@prisma/client` and its native engine — stays external.
 */
const WORKSPACE_PACKAGES = Object.keys(workspaceAliases);

function gitCommit(): string {
  const fromEnvironment = process.env.CLOUDFORGE_GIT_COMMIT ?? process.env.GITHUB_SHA;
  if (fromEnvironment) return fromEnvironment.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: resolve(__dirname, '../..'),
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

const builtAt = process.env.CLOUDFORGE_BUILD_DATE ?? new Date().toISOString();
const buildNumber =
  process.env.CLOUDFORGE_BUILD_NUMBER ?? `${builtAt.slice(0, 10).replaceAll('-', '')}.dev`;
const buildInfo = { buildNumber, gitCommit: gitCommit(), builtAt };

export default defineConfig({
  main: {
    define: {
      __CLOUDFORGE_BUILD_INFO__: JSON.stringify(buildInfo),
    },
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    resolve: {
      alias: {
        ...workspaceAliases,
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    resolve: {
      alias: {
        ...workspaceAliases,
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        // More specific subpath aliases must precede the bare package alias so
        // that Vite's ordered prefix matching resolves them first.
        '@cloudforge/ui/styles.css': resolve(__dirname, '../../packages/ui/src/styles/globals.css'),
        ...workspaceAliases,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@desktop-build': resolve(__dirname, 'build'),
        '@docs': resolve(__dirname, '../../docs'),
      },
    },
    plugins: [react(), productionCspMeta()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
