import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      all: true,
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/*.spec.*',
        '**/index.ts',
        '**/*.d.ts',
        '**/out/**',
        '**/dist/**',
        '**/release/**',
        '**/generated/**',
      ],
      reporter: ['text', 'json-summary', 'html'],
    },
  },
});
