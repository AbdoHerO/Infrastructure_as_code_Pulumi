import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup, resolve4, resolve6 } from 'node:dns/promises';
import { app } from 'electron';
import { DeploymentError, err, InfrastructureError, ok, unwrap } from '@cloudforge/shared';
import {
  ActivityService,
  CloudflareService,
  CloudflareDnsAutomationService,
  CredentialService,
  type ContainerManager,
  type AnsibleManager,
  NginxService,
  SslService,
  type DomainResolver,
  type RemoteTargetResolver,
  DeploymentService,
  InfrastructureService,
  ManagedVpsTargetSyncService,
  PluginService,
  ProjectConfigurationService,
  ProjectService,
  type ProviderCredentialResolver,
  ProviderConnectionService,
  SettingsService,
  SshKeyService,
  SshTerminalService,
  VpsTargetService,
  JenkinsPipelineService,
  isProvisioningProviderKind,
} from '@cloudforge/core';
import { DefaultProviderFactory } from '@cloudforge/providers';
import { DefaultServiceProviderFactory } from '@cloudforge/service-providers';
import {
  NodeSshKeyGenerator,
  SshAnsibleManager,
  SshContainerManager,
  SshDeployer,
  SshNginxManager,
  SshCertificateManager,
  NodeSshTerminalManager,
  JenkinsHttpManager,
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
  PrismaJenkinsPipelineRepository,
} from '@cloudforge/database';
import { createSecretCipher } from './security/secret-cipher.js';
import { createInfrastructureEngine } from './infra/engine.js';
import { log, pruneLogs } from './logging/logger.js';
import { projectStackReference } from './infra/stack-reference.js';
import { emitEvent } from './ipc/emit.js';

/**
 * The composition root. Wires concrete Infrastructure implementations into the
 * Application services once, at startup, and exposes them to the IPC layer.
 * This is the only place that knows how the object graph is assembled.
 */
export interface AppContainer {
  readonly projectService: ProjectService;
  readonly projectConfigurationService: ProjectConfigurationService;
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
  readonly sshTerminalService: SshTerminalService;
  readonly cloudflareService: CloudflareService;
  readonly cloudflareDnsAutomationService: CloudflareDnsAutomationService;
  readonly jenkinsPipelineService: JenkinsPipelineService;
  readonly secretsBackedByOsKeychain: boolean;
  synchronizeData(): Promise<{ warnings: readonly string[] }>;
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
  const cloudflareService = new CloudflareService(
    credentialService,
    new DefaultServiceProviderFactory(
      process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4',
    ),
    activityService,
    settingsService,
  );
  const pluginService = new PluginService(new PrismaPluginRepository(db));
  const sshKeyService = new SshKeyService(credentialService, new NodeSshKeyGenerator());
  const containerManager = new SshContainerManager();
  const ansibleManager = new SshAnsibleManager();
  const vpsTargetService = new VpsTargetService(new PrismaVpsTargetRepository(db));
  const targetSyncService = new ManagedVpsTargetSyncService(
    vpsTargetService,
    sshKeyService,
    deploymentService,
  );
  const infrastructureService = new InfrastructureService(
    createInfrastructureEngine(),
    new PrismaPlanStore(db),
    credentialResolver,
    new PrismaTemplateStore(db),
    targetSyncService,
  );
  const projectConfigurationService = new ProjectConfigurationService(
    projectService,
    infrastructureService,
    projectStackReference,
    activityService,
  );
  const remoteTargetResolver: RemoteTargetResolver = {
    async resolve(targetId) {
      const saved = await vpsTargetService.get(targetId);
      if (!saved.ok)
        return err(new DeploymentError('Could not load the VPS target', { cause: saved.error }));
      if (!saved.value.sshCredentialId)
        return err(new DeploymentError('The VPS target has no SSH credential'));
      const authentication = await sshKeyService.resolveAuthentication(saved.value.sshCredentialId);
      if (!authentication.ok)
        return err(
          new DeploymentError('Could not decrypt the VPS SSH credential', {
            cause: authentication.error,
          }),
        );
      return ok({
        host: saved.value.host,
        port: saved.value.port,
        username: saved.value.username,
        hostKeySha256: saved.value.hostKeySha256,
        ...authentication.value,
      });
    },
  };
  const nginxService = new NginxService(
    remoteTargetResolver,
    new SshNginxManager(),
    activityService,
  );
  const sshTerminalService = new SshTerminalService(
    remoteTargetResolver,
    new NodeSshTerminalManager(),
    activityService,
  );
  const domainResolver: DomainResolver = {
    async resolve(domain) {
      try {
        const [ipv4, ipv6] = await Promise.all([
          resolve4(domain).catch(() => []),
          resolve6(domain).catch(() => []),
        ]);
        let addresses = [...ipv4, ...ipv6];
        if (addresses.length === 0) {
          const systemAddresses = await lookup(domain, { all: true }).catch(() => []);
          addresses = systemAddresses.map((item) => item.address);
        }
        return addresses.length > 0
          ? ok(addresses)
          : err(new DeploymentError(`DNS has no A or AAAA record for ${domain}`));
      } catch (cause) {
        return err(new DeploymentError(`Could not resolve DNS for ${domain}`, { cause }));
      }
    },
  };
  const cloudflareDnsAutomationService = new CloudflareDnsAutomationService(
    cloudflareService,
    settingsService,
    domainResolver,
    activityService,
  );
  const jenkinsPipelineService = new JenkinsPipelineService(
    new PrismaJenkinsPipelineRepository(db),
    vpsTargetService,
    credentialService,
    new JenkinsHttpManager(),
    activityService,
    cloudflareDnsAutomationService,
    nginxService,
  );
  const sslService = new SslService(
    remoteTargetResolver,
    domainResolver,
    new SshCertificateManager(),
    activityService,
    settingsService,
    nginxService,
    cloudflareDnsAutomationService,
    cloudflareService,
  );
  const sslRenewalTimer = setInterval(
    () => void sslService.renewDue(),
    appSettings.ssl.checkIntervalHours * 60 * 60_000,
  );
  sslRenewalTimer.unref();
  setTimeout(() => void sslService.renewDue(), 30_000).unref();

  let cloudflareSnapshot = '';
  const synchronizeCloudflare = async (): Promise<{ warnings: readonly string[] }> => {
    const settings = await settingsService.get();
    if (!settings.ok) return { warnings: [settings.error.message] };
    const config = settings.value.cloudflare;
    if (!config.autoSync || !config.defaultCredentialId) return { warnings: [] };
    const zones = await cloudflareService.zones(config.defaultCredentialId);
    if (!zones.ok) return { warnings: [zones.error.message] };
    const state: {
      zoneId: string;
      records: readonly { id: string; modifiedAt: string }[];
      ssl: string;
      cache: string;
      security: string;
    }[] = [];
    for (const zone of zones.value) {
      const [records, zoneSettings, security] = await Promise.all([
        cloudflareService.dnsRecords(config.defaultCredentialId, zone.id),
        cloudflareService.zoneSettings(config.defaultCredentialId, zone.id),
        cloudflareService.security(config.defaultCredentialId, zone.id),
      ]);
      if (!records.ok) return { warnings: [records.error.message] };
      state.push({
        zoneId: zone.id,
        records: records.value.map((record) => ({ id: record.id, modifiedAt: record.modifiedAt })),
        ssl: zoneSettings.ok
          ? JSON.stringify({
              mode: zoneSettings.value.sslMode,
              minimumTls: zoneSettings.value.minimumTls,
              tls13: zoneSettings.value.tls13,
              hsts: zoneSettings.value.hsts,
              alwaysHttps: zoneSettings.value.alwaysHttps,
              rewrites: zoneSettings.value.automaticHttpsRewrites,
            })
          : '',
        cache: zoneSettings.ok
          ? JSON.stringify({
              level: zoneSettings.value.cacheLevel,
              browserTtl: zoneSettings.value.browserCacheTtl,
              development: zoneSettings.value.developmentMode,
              brotli: zoneSettings.value.brotli,
            })
          : '',
        security: security.ok
          ? JSON.stringify({
              level: security.value.securityLevel,
              browserIntegrity: security.value.browserIntegrityCheck,
              rules: security.value.rules.map((rule) => `${rule.id}:${rule.status}`),
            })
          : '',
      });
    }
    const next = JSON.stringify(state);
    if (cloudflareSnapshot && next !== cloudflareSnapshot) {
      const previous = JSON.parse(cloudflareSnapshot) as typeof state;
      const previousZones = new Set(previous.map((item) => item.zoneId));
      const nextZones = new Set(state.map((item) => item.zoneId));
      const changedSetting = (field: 'ssl' | 'cache' | 'security'): boolean =>
        state.some(
          (item) =>
            previous.find((candidate) => candidate.zoneId === item.zoneId)?.[field] !== item[field],
        );
      const reason = state.some((item) => !previousZones.has(item.zoneId))
        ? 'zone-added'
        : previous.some((item) => !nextZones.has(item.zoneId))
          ? 'zone-deleted'
          : changedSetting('ssl')
            ? 'ssl-changed'
            : changedSetting('cache')
              ? 'cache-changed'
              : changedSetting('security')
                ? 'security-changed'
                : 'dns-changed';
      if (config.activityLogging)
        activityService.recordSafe({
          type: 'cloudflare.synchronization.changed',
          message: `Cloudflare ${reason.replace('-', ' ')} detected outside CloudForge`,
          metadata: { zones: zones.value.length, reason },
        });
      emitEvent('cloudflare:changed', { reason });
    } else {
      emitEvent('cloudflare:changed', { reason: 'synchronized' });
    }
    cloudflareSnapshot = next;
    return { warnings: [] };
  };
  const cloudflareSyncTimer = setInterval(
    () => void synchronizeCloudflare(),
    appSettings.cloudflare.autoRefreshMinutes * 60_000,
  );
  cloudflareSyncTimer.unref();

  container = {
    projectService,
    projectConfigurationService,
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
    sshTerminalService,
    cloudflareService,
    cloudflareDnsAutomationService,
    jenkinsPipelineService,
    secretsBackedByOsKeychain: cipher.backedByOsKeychain,
    synchronizeData: async () => {
      const [targets, cloudflare] = await Promise.all([
        reconcileManagedTargets(projectService, infrastructureService, vpsTargetService),
        synchronizeCloudflare(),
      ]);
      return { warnings: [...targets.warnings, ...cloudflare.warnings] };
    },
    snapshotDatabase: async (destination) => {
      await db.$executeRawUnsafe('VACUUM INTO ?', destination);
    },
    dispose: async () => {
      clearInterval(sslRenewalTimer);
      clearInterval(cloudflareSyncTimer);
      sshTerminalService.closeAll();
      await db.$disconnect();
      container = null;
    },
  };
  log().info({ event: 'container.ready' }, 'Application services initialised');
  setTimeout(() => {
    void reconcileManagedTargets(projectService, infrastructureService, vpsTargetService);
  }, 2_000).unref();
  setTimeout(() => void synchronizeCloudflare(), 5_000).unref();
  return container;
}

async function reconcileManagedTargets(
  projects: ProjectService,
  infrastructure: InfrastructureService,
  targets: VpsTargetService,
): Promise<{ warnings: readonly string[] }> {
  const warnings: string[] = [];
  const [projectList, stacks] = await Promise.all([
    projects.list(),
    infrastructure.listManagedStacks(),
  ]);
  if (!projectList.ok) {
    log().warn({ event: 'vps-target.reconcile.skipped' }, 'Could not discover managed stacks');
    warnings.push(projectList.error.message);
    return { warnings };
  }
  if (!stacks.ok) {
    log().warn({ event: 'vps-target.reconcile.skipped' }, 'Could not discover managed stacks');
    warnings.push(stacks.error.message);
    return { warnings };
  }
  const projectIds = projectList.value.map((project) => project.id);
  const orphanCleanup = await targets.removeManagedOutsideProjects(projectIds);
  if (!orphanCleanup.ok) warnings.push(orphanCleanup.error.message);

  for (const project of projectList.value) {
    const ref = projectStackReference(project);
    const exists = stacks.value.some(
      (stack) => stack.ref.project === ref.project && stack.ref.stack === ref.stack,
    );
    if (!exists) {
      const removed = await targets.removeManagedProject(project.id);
      if (!removed.ok) warnings.push(removed.error.message);
      continue;
    }
    const outputs = await infrastructure.outputs(ref, project.id);
    if (!outputs.ok) {
      log().warn(
        { event: 'vps-target.reconcile.failed', projectId: project.id, err: outputs.error },
        'Could not synchronize managed VPS targets',
      );
      warnings.push(outputs.error.message);
      continue;
    }
  }
  emitEvent('vpsTargets:changed', { reason: 'synchronized' });
  return { warnings };
}

/** Access the initialised container. Throws if called before {@link initContainer}. */
export function getContainer(): AppContainer {
  if (!container) throw new Error('Application container has not been initialised');
  return container;
}
