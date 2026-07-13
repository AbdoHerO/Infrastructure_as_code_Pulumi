import { PrismaClient } from '@prisma/client';

export { PrismaClient };

/** The concrete database handle type used throughout the Infrastructure layer. */
export type Db = PrismaClient;

/**
 * Create a Prisma client bound to a specific SQLite database file. The URL is
 * supplied at runtime (e.g. the Electron `userData` directory), so no ambient
 * `DATABASE_URL` is required to run the application.
 *
 * @param databaseUrl - A SQLite connection URL, e.g. `file:/path/to/app.db`.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: ['warn', 'error'],
  });
}
