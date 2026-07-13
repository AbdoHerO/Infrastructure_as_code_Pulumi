import { join } from 'node:path';
import { app } from 'electron';
import { unwrap } from '@cloudforge/shared';
import {
  CredentialService,
  InfrastructureService,
  ProjectService,
  ProviderConnectionService,
  SettingsService,
} from '@cloudforge/core';
import { DefaultProviderFactory } from '@cloudforge/providers';
import {
  createPrismaClient,
  type Db,
  ensureSchema,
  PrismaCredentialRepository,
  PrismaPlanStore,
  PrismaProjectRepository,
  PrismaSettingsRepository,
} from '@cloudforge/database';
import { createSecretCipher } from './security/secret-cipher.js';
import { createInfrastructureEngine } from './infra/engine.js';

/**
 * The composition root. Wires concrete Infrastructure implementations into the
 * Application services once, at startup, and exposes them to the IPC layer.
 * This is the only place that knows how the object graph is assembled.
 */
export interface AppContainer {
  readonly projectService: ProjectService;
  readonly credentialService: CredentialService;
  readonly settingsService: SettingsService;
  readonly providerService: ProviderConnectionService;
  readonly infrastructureService: InfrastructureService;
  readonly secretsBackedByOsKeychain: boolean;
  dispose(): Promise<void>;
}

let container: AppContainer | null = null;

/** Build a SQLite `file:` URL from an absolute path (cross-platform). */
function toSqliteUrl(absolutePath: string): string {
  return `file:${absolutePath.replace(/\\/g, '/')}`;
}

/** Initialise the database and application services. Idempotent. */
export async function initContainer(): Promise<AppContainer> {
  if (container) return container;

  const dbPath = join(app.getPath('userData'), 'cloudforge.db');
  const db: Db = createPrismaClient(toSqliteUrl(dbPath));
  await db.$connect();
  await ensureSchema(db);

  // `unwrap` is safe here: a missing cipher is an unrecoverable startup fault.
  const cipher = unwrap(createSecretCipher());

  const projectService = new ProjectService(new PrismaProjectRepository(db));
  const credentialService = new CredentialService(new PrismaCredentialRepository(db), cipher);
  const settingsService = new SettingsService(new PrismaSettingsRepository(db));
  const providerService = new ProviderConnectionService(
    credentialService,
    new DefaultProviderFactory(),
  );
  const infrastructureService = new InfrastructureService(
    createInfrastructureEngine(),
    new PrismaPlanStore(db),
  );

  container = {
    projectService,
    credentialService,
    settingsService,
    providerService,
    infrastructureService,
    secretsBackedByOsKeychain: cipher.backedByOsKeychain,
    dispose: async () => {
      await db.$disconnect();
      container = null;
    },
  };
  return container;
}

/** Access the initialised container. Throws if called before {@link initContainer}. */
export function getContainer(): AppContainer {
  if (!container) throw new Error('Application container has not been initialised');
  return container;
}
