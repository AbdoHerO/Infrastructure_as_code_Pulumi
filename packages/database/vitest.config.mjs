import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites create real SQLite databases and rebuild schemas. Running
    // them concurrently on Windows causes Prisma query-engine file locking,
    // especially on slower GitHub-hosted runners.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
