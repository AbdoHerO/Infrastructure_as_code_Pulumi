import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve4, resolve6 } from 'node:dns/promises';
import { app } from 'electron';
import { DeploymentError, err, InfrastructureError, ok, unwrap } from '@cloudforge/shared';
import {
  ActivityService,
  CredentialService,
  type ContainerManager,
  type AnsibleManager,
  NginxService,
  SslService,
  type DomainResolver,
  type RemoteTargetResolver,
  DeploymentService,
  InfrastructureService,
  PluginService,
  ProjectService,
  type ProviderCredentialResolver,
  ProviderConnectionService,
  SettingsService,
  SshKeyService,
  VpsTargetService,
  isProvisioningProviderKind,
} from '@cloudforge/core';
import { DefaultProviderFactory } from '@cloudforge/providers';
import {
  NodeSshKeyGenerator,
  SshAnsibleManager,
  SshContainerManager,
  SshDeployer,
  SshNginxManager,
  SshCertificateManager,
} from '@cloudforge/deployment';
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
  PrismaVpsTargetRepository,
} from '@cloudforge/database';
import { createSecretCipher } from './security/secret-cipher.js';
import { createInfrastructureEngine } from './infra/engine.js';
import { log, pruneLogs } from './logging/logger.js';

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
  readonly sshKeyService: SshKeyService;
  readonly containerManager: ContainerManager;
  readonly ansibleManager: AnsibleManager;
  readonly vpsTargetService: VpsTargetService;
  readonly nginxService: NginxService;
  readonly sslService: SslService;
  readonly secretsBackedByOsKeychain: boolean;
  snapshotDatabase(destination: string): Promise<void>;
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
  // Apply additive schema upgrades and repair the legacy Project provider FK.
  // The only table rebuild is backed up before it begins.
  const migrated = await migrateSchema(db, {
    onBeforeProjectRebuild: async () => {
      const backup = `${dbPath}.bak-${Date.now()}`;
      await copyFile(dbPath, backup);
      log().warn({ event: 'schema.backup', backup }, 'Backed up database before migration');
    },
  });
  if (migrated) {
    log().info({ event: 'schema.migrated' }, 'Applied database schema migrations');
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
  const appSettings = unwrap(await settingsService.get());
  const prunedLogs = pruneLogs(appSettings.logs.retentionDays);
  if (prunedLogs > 0) log().info({ event: 'logs.pruned', count: prunedLogs }, 'Pruned old logs');
  const providerService = new ProviderConnectionService(
    credentialService,
    new DefaultProviderFactory(),
  );
  // Resolve a project's linked cloud credential into the raw fields the
  // infrastructure engine needs to authenticate against the provider account.
  const credentialResolver: ProviderCredentialResolver = {
    async forProject(projectId) {
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
      if (!isProvisioningProviderKind(credential.value.kind)) {
        return err(
          new InfrastructureError(
            `${credential.value.kind} infrastructure provisioning is not enabled yet.`,
            { context: { projectId, providerKind: credential.value.kind } },
          ),
        );
      }
      return ok({ providerKind: credential.value.kind, data: credential.value.data });
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
  const recoveredDeployments = unwrap(await deploymentService.recoverInterrupted());
  if (recoveredDeployments > 0) {
    log().warn(
      { event: 'deploy.recovered', count: recoveredDeployments },
      'Marked interrupted deployments as failed',
    );
  }
  const activityService = new ActivityService(new PrismaActivityRepository(db));
  const pluginService = new PluginService(new PrismaPluginRepository(db));
  const sshKeyService = new SshKeyService(credentialService, new NodeSshKeyGenerator());
  const containerManager = new SshContainerManager();
  const ansibleManager = new SshAnsibleManager();
  const vpsTargetService = new VpsTargetService(new PrismaVpsTargetRepository(db));
  const remoteTargetResolver: RemoteTargetResolver = {
    async resolve(targetId) {
      const saved = await vpsTargetService.get(targetId);
      if (!saved.ok)
        return err(new DeploymentError('Could not load the VPS target', { cause: saved.error }));
      if (!saved.value.sshCredentialId)
        return err(new DeploymentError('The VPS target has no SSH credential'));
      const revealed = await credentialService.reveal(saved.value.sshCredentialId);
      if (!revealed.ok)
        return err(
          new DeploymentError('Could not decrypt the VPS SSH credential', {
            cause: revealed.error,
          }),
        );
      if (revealed.value.kind !== 'ssh' && revealed.value.kind !== 'ssh-password')
        return err(new DeploymentError('The VPS target credential is not an SSH credential'));
      const { privateKey, password, passphrase } = revealed.value.data;
      if (!privateKey && !password)
        return err(new DeploymentError('The VPS SSH credential is empty'));
      return ok({
        host: saved.value.host,
        port: saved.value.port,
        username: saved.value.username,
        hostKeySha256: saved.value.hostKeySha256,
        ...(privateKey ? { privateKey } : {}),
        ...(password ? { password } : {}),
        ...(passphrase ? { passphrase } : {}),
      });
    },
  };
  const nginxService = new NginxService(
    remoteTargetResolver,
    new SshNginxManager(),
    activityService,
  );
  const domainResolver: DomainResolver = {
    async resolve(domain) {
      try {
        const [ipv4, ipv6] = await Promise.all([
          resolve4(domain).catch(() => []),
          resolve6(domain).catch(() => []),
        ]);
        const addresses = [...ipv4, ...ipv6];
        return addresses.length > 0
          ? ok(addresses)
          : err(new DeploymentError(`DNS has no A or AAAA record for ${domain}`));
      } catch (cause) {
        return err(new DeploymentError(`Could not resolve DNS for ${domain}`, { cause }));
      }
    },
  };
  const sslService = new SslService(
    remoteTargetResolver,
    domainResolver,
    new SshCertificateManager(),
    activityService,
    settingsService,
    nginxService,
  );
  const sslRenewalTimer = setInterval(
    () => void sslService.renewDue(),
    appSettings.ssl.checkIntervalHours * 60 * 60_000,
  );
  sslRenewalTimer.unref();
  setTimeout(() => void sslService.renewDue(), 30_000).unref();

  container = {
    projectService,
    credentialService,
    settingsService,
    providerService,
    infrastructureService,
    deploymentService,
    activityService,
    pluginService,
    sshKeyService,
    containerManager,
    ansibleManager,
    vpsTargetService,
    nginxService,
    sslService,
    secretsBackedByOsKeychain: cipher.backedByOsKeychain,
    snapshotDatabase: async (destination) => {
      await db.$executeRawUnsafe('VACUUM INTO ?', destination);
    },
    dispose: async () => {
      clearInterval(sslRenewalTimer);
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
