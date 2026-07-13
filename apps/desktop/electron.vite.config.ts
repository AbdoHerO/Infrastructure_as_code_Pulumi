import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Workspace packages are published as TypeScript source, so we alias them to
 * their entry files and let Vite/esbuild transpile them as first-party code.
 */
const workspaceAliases = {
  '@cloudforge/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
  '@cloudforge/core': resolve(__dirname, '../../packages/core/src/index.ts'),
  '@cloudforge/database': resolve(__dirname, '../../packages/database/src/index.ts'),
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

export default defineConfig({
  main: {
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
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
