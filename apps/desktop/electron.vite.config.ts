import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Workspace packages are published as TypeScript source, so we alias them to
 * their entry files and let Vite/esbuild transpile them as first-party code.
 */
const workspaceAliases = {
  '@cloudforge/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
  '@cloudforge/ui': resolve(__dirname, '../../packages/ui/src/index.ts'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [externalizeDepsPlugin()],
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
