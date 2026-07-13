/**
 * Vitest workspace: lets `vitest run --coverage` execute every package's tests
 * from the repo root with a single coverage report. Per-package `pnpm test`
 * (via Turborepo) continues to work independently.
 */
export default ['packages/*', 'apps/*'];
