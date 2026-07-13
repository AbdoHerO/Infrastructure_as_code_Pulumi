import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { err, InfrastructureError, ok, type Result, unwrap } from '@cloudforge/shared';
import {
  ActivityService,
  CredentialService,
  DeploymentService,
  InfrastructureService,
  PluginService,
  ProjectService,
  type ProviderCredentialResolver,
  type ProviderCredentials,
  ProviderConnectionService,
  SettingsService,
} from '@cloudforge/core';
import { DefaultProviderFactory } from '@cloudforge/providers';
import { SshDeployer } from '@cloudforge/deployment';
import {
  createPrismaClient,
  type Db,
  ensureSchema,
  migrateSchema,
  PrismaActivityRepository,
  PrismaCredentialRepository,
  PrismaDeploymentRepository,
  PrismaPlanStore,
  PrismaPluginRepository,
  PrismaProjectRepository,
  PrismaSettingsRepository,
  PrismaTemplateStore,
} from '@cloudforge/database';
import { createSecretCipher } from './security/secret-cipher.js';
import { createInfrastructureEngine } from './infra/engine.js';
import { log } from './logging/logger.js';

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
  readonly deploymentService: DeploymentService;
  readonly activityService: ActivityService;
  readonly pluginService: PluginService;
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
  // Repair older databases whose Project.providerId FK targeted the unused
  // Provider table. Backs the file up before the (rare, one-time) table rebuild.
  const migrated = await migrateSchema(db, {
    onBeforeProjectRebuild: async () => {
      const backup = `${dbPath}.bak-${Date.now()}`;
      await copyFile(dbPath, backup);
      log().warn({ event: 'schema.backup', backup }, 'Backed up database before migration');
    },
  });
  if (migrated) {
    log().info(
      { event: 'schema.migrated' },
      'Migrated Project.providerId foreign key to reference Credential',
    );
  }
  log().info({ event: 'db.ready', dbPath }, 'Database connected and schema ensured');

  // `unwrap` is safe here: a missing cipher is an unrecoverable startup fault.
  const cipher = unwrap(createSecretCipher());
  log().info(
    { event: 'cipher.ready', backedByOsKeychain: cipher.backedByOsKeychain },
    `Secret encryption ready (${cipher.backedByOsKeychain ? 'OS keychain' : 'local key'})`,
  );

  const projectService = new ProjectService(new PrismaProjectRepository(db));
  const credentialService = new CredentialService(new PrismaCredentialRepository(db), cipher);
  const settingsService = new SettingsService(new PrismaSettingsRepository(db));
  const providerService = new ProviderConnectionService(
    credentialService,
    new DefaultProviderFactory(),
  );
  // Resolve a project's linked cloud credential into the raw fields the
  // infrastructure engine needs to authenticate against the provider account.
  const credentialResolver: ProviderCredentialResolver = {
    async forProject(projectId): Promise<Result<ProviderCredentials, InfrastructureError>> {
      const project = await projectService.get(projectId);
      if (!project.ok) {
        return err(new InfrastructureError('Could not load project', { cause: project.error }));
      }
      const providerId = project.value.providerId;
      if (!providerId) {
        return err(
          new InfrastructureError(
            'No cloud provider is linked to this project. Open the project settings and select a provider credential before deploying.',
            { context: { projectId } },
          ),
        );
      }
      const credential = await credentialService.getDecrypted(providerId);
      if (!credential.ok) {
        return err(
          new InfrastructureError('Could not load the project’s provider credential', {
            cause: credential.error,
          }),
        );
      }
      return ok(credential.value.data);
    },
  };

  const infrastructureService = new InfrastructureService(
    createInfrastructureEngine(),
    new PrismaPlanStore(db),
    credentialResolver,
    new PrismaTemplateStore(db),
  );
  const deploymentService = new DeploymentService(
    new SshDeployer(),
    new PrismaDeploymentRepository(db),
  );
  const activityService = new ActivityService(new PrismaActivityRepository(db));
  const pluginService = new PluginService(new PrismaPluginRepository(db));

  container = {
    projectService,
    credentialService,
    settingsService,
    providerService,
    infrastructureService,
    deploymentService,
    activityService,
    pluginService,
    secretsBackedByOsKeychain: cipher.backedByOsKeychain,
    dispose: async () => {
      await db.$disconnect();
      container = null;
    },
  };
  log().info({ event: 'container.ready' }, 'Application services initialised');
  return container;
}

/** Access the initialised container. Throws if called before {@link initContainer}. */
export function getContainer(): AppContainer {
  if (!container) throw new Error('Application container has not been initialised');
  return container;
}
