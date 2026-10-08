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
  ContainerService,
  RuntimePlanService,
  type AnsibleManager,
  NginxService,
  HostFirewallService,
  SslService,
  type DomainResolver,
  type RemoteTargetResolver,
  DeploymentService,
  InfrastructureService,
  ManagedVpsTargetSyncService,
  PluginService,
  ProjectConfigurationService,
  ProjectDuplicationService,
  InMemoryProjectContext,
  ProjectService,
  ProjectSessionService,
  type ProjectContext,
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
  AnsibleNativeServiceRequirements,
  SshHostFirewallManager,
  SshRuntimeApplier,
  SshRuntimeInspector,
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
  migrateProjectOwnership,
  PrismaActivityRepository,
  PrismaCredentialRepository,
  PrismaDeploymentRepository,
  PrismaPlanStore,
  PrismaRuntimePlanStore,
  PrismaPluginRepository,
  PrismaProjectRepository,
  PrismaProjectConfigurationCloner,
  PrismaProjectSummaryReader,
  PrismaSettingsRepository,
  PrismaSystemSettingsRepository,
  PrismaTemplateStore,
  PrismaVpsTargetRepository,
  PrismaJenkinsPipelineRepository,
  isolateProjectSnapshot,
  restoreProjectSnapshot,
  importProjectSnapshot,
} from '@cloudforge/database';
import { createSecretCipher } from './security/secret-cipher.js';
import {
  clearMaterializedProjectKeyRoot,
  removeMaterializedProjectKeys,
} from './security/project-key-files.js';
import { NodeProjectPasskeyHasher } from './security/project-passkey-hasher.js';
import { createInfrastructureEngine } from './infra/engine.js';
import { log, pruneLogs, setActiveLogProject } from './logging/logger.js';
import { projectStackReference } from './infra/stack-reference.js';
import { emitEvent } from './ipc/emit.js';
import { projectOperations } from './project-operation-registry.js';
import {
  LiveRuntimeProviderFirewall,
  VpsRuntimeTargetCatalog,
} from './runtime/runtime-target-adapters.js';

/**
 * The composition root. Wires concrete Infrastructure implementations into the
 * Application services once, at startup, and exposes them to the IPC layer.
 * This is the only place that knows how the object graph is assembled.
 */
export interface AppContainer {
  readonly projectService: ProjectService;
  readonly projectContext: ProjectContext;
  readonly projectSessionService: ProjectSessionService;
  readonly projectConfigurationService: ProjectConfigurationService;
  readonly projectDuplicationService: ProjectDuplicationService;
  readonly credentialService: CredentialService;
  readonly settingsService: SettingsService;
  readonly systemSettingsService: SettingsService;
  readonly providerService: ProviderConnectionService;
  readonly infrastructureService: InfrastructureService;
  readonly deploymentService: DeploymentService;
  readonly activityService: ActivityService;
  readonly pluginService: PluginService;
  readonly sshKeyService: SshKeyService;
  readonly containerManager: ContainerManager;
  readonly containerService: ContainerService;
  readonly runtimePlanService: RuntimePlanService;
  readonly ansibleManager: AnsibleManager;
  readonly vpsTargetService: VpsTargetService;
  readonly nginxService: NginxService;
  readonly hostFirewallService: HostFirewallService;
  readonly sslService: SslService;
  readonly sshTerminalService: SshTerminalService;
  readonly cloudflareService: CloudflareService;
  readonly cloudflareDnsAutomationService: CloudflareDnsAutomationService;
  readonly jenkinsPipelineService: JenkinsPipelineService;
  readonly secretsBackedByOsKeychain: boolean;
  synchronizeData(): Promise<{ warnings: readonly string[] }>;
  snapshotDatabase(destination: string): Promise<void>;
  snapshotProjectDatabase(destination: string, projectId: string): Promise<void>;
  restoreProjectDatabase(source: string, projectId: string): Promise<void>;
  exportProjectSecrets(projectId: string): Promise<PortableProjectSecrets>;
  rewrapProjectSecrets(projectId: string, secrets: PortableProjectSecrets): Promise<void>;
  importProjectDatabase(
    source: string,
    projectId: string,
    passkey: string,
    portableSecrets: PortableProjectSecrets,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export interface PortableProjectSecrets {
  readonly format: 1;
  readonly credentials: Readonly<Record<string, string>>;
  readonly sshKeys: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

let container: AppContainer | null = null;

/** Build a SQLite `file:` URL from an absolute path (cross-platform). */
function toSqliteUrl(absolutePath: string): string {
  return `file:${absolutePath.replace(/\\/g, '/')}`;
}

/** Initialise the database and application services. Idempotent. */
export async function initContainer(): Promise<AppContainer> {
  if (container) return container;

  // Private keys exported explicitly by the user are never stored here.
  // This directory contains only transient SSH command material and is safe
  // to clear after a crash or forced shutdown.
  try {
    await clearMaterializedProjectKeyRoot();
  } catch (error) {
    // Transient files from a previous crash must be cleaned whenever possible,
    // but an antivirus/file-system lock must not permanently brick startup.
    // Project unlock still hardens every newly materialized key and project
    // lock remains fail-closed if its own key cleanup cannot complete.
    log().warn(
      { err: error, event: 'runtime-keys.cleanup-failed' },
      'Could not remove stale transient SSH keys during startup',
    );
  }
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
  const ownershipMigrated = await migrateProjectOwnership(db, {
    onBeforeMigration: async () => {
      const backup = `${dbPath}.workspace-bak-${Date.now()}`;
      await copyFile(dbPath, backup);
      log().warn(
        { event: 'schema.workspaceBackup', backup },
        'Backed up database before project ownership migration',
      );
    },
  });
  if (ownershipMigrated) {
    log().info(
      { event: 'schema.projectOwnershipMigrated' },
      'Assigned legacy workspace data to projects',
    );
  }
  log().info({ event: 'db.ready', dbPath }, 'Database connected and schema ensured');

  // `unwrap` is safe here: a missing cipher is an unrecoverable startup fault.
  const cipher = unwrap(createSecretCipher());
  log().info(
    { event: 'cipher.ready', backedByOsKeychain: cipher.backedByOsKeychain },
    `Secret encryption ready (${cipher.backedByOsKeychain ? 'OS keychain' : 'local key'})`,
  );

  const projectRepository = new PrismaProjectRepository(db);
  const projectContext = new InMemoryProjectContext();
  const projectPasskeys = new NodeProjectPasskeyHasher();
  const projectService = new ProjectService(
    projectRepository,
    projectPasskeys,
    new PrismaProjectSummaryReader(db),
  );
  const credentialService = new CredentialService(
    new PrismaCredentialRepository(db, projectContext),
    cipher,
  );
  const systemSettingsService = new SettingsService(new PrismaSystemSettingsRepository(db));
  const settingsService = new SettingsService(new PrismaSettingsRepository(db, projectContext));
  const appSettings = unwrap(await systemSettingsService.get());
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
      const activeProjectId = projectContext.requireActive().projectId;
      if (projectId !== activeProjectId) {
        return err(
          new InfrastructureError('Cannot use credentials from another project', {
            context: { projectId, activeProjectId },
          }),
        );
      }
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
    new PrismaDeploymentRepository(db, projectContext),
  );
  const activityService = new ActivityService(new PrismaActivityRepository(db, projectContext));
  const pluginService = new PluginService(new PrismaPluginRepository(db, projectContext));
  const sshKeyService = new SshKeyService(credentialService, new NodeSshKeyGenerator());
  const containerManager = new SshContainerManager();
  const ansibleManager = new SshAnsibleManager();
  const runtimePlanStore = new PrismaRuntimePlanStore(db, projectContext);
  const vpsTargetService = new VpsTargetService(
    new PrismaVpsTargetRepository(db, projectContext),
    runtimePlanStore,
  );
  const targetSyncService = new ManagedVpsTargetSyncService(
    vpsTargetService,
    sshKeyService,
    deploymentService,
  );
  const infrastructureService = new InfrastructureService(
    createInfrastructureEngine(),
    new PrismaPlanStore(db, projectContext),
    credentialResolver,
    new PrismaTemplateStore(db, projectContext),
    targetSyncService,
  );
  const projectConfigurationService = new ProjectConfigurationService(
    projectService,
    infrastructureService,
    projectStackReference,
    activityService,
  );
  const projectDuplicationService = new ProjectDuplicationService(
    projectService,
    new PrismaProjectConfigurationCloner(db),
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
  const runtimeInspector = new SshRuntimeInspector();
  const containerService = new ContainerService(
    remoteTargetResolver,
    containerManager,
    runtimeInspector,
    activityService,
  );
  const runtimePlanService = new RuntimePlanService(
    runtimePlanStore,
    remoteTargetResolver,
    runtimeInspector,
    activityService,
    new SshRuntimeApplier(),
    new SshHostFirewallManager(),
    new AnsibleNativeServiceRequirements(ansibleManager),
    new LiveRuntimeProviderFirewall(vpsTargetService, projectService, providerService),
    new VpsRuntimeTargetCatalog(vpsTargetService),
  );
  const cloudflareService = new CloudflareService(
    credentialService,
    new DefaultServiceProviderFactory(
      process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4',
    ),
    activityService,
    settingsService,
    runtimePlanService,
  );
  const nginxService = new NginxService(
    remoteTargetResolver,
    new SshNginxManager(),
    activityService,
    runtimePlanService,
  );
  // The VPS's own firewall, port by port from the Firewall page: for ports no
  // runtime plan can derive (a hosting layer beside CloudForge, a hand-installed
  // daemon). Same SSH firewall manager as the runtime plan uses.
  const hostFirewallService = new HostFirewallService(
    remoteTargetResolver,
    new SshHostFirewallManager(),
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
    new PrismaJenkinsPipelineRepository(db, projectContext),
    vpsTargetService,
    credentialService,
    new JenkinsHttpManager(),
    activityService,
    cloudflareDnsAutomationService,
    nginxService,
    runtimePlanService,
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
    runtimePlanService,
  );
  const lastSslCheck = new Map<string, number>();
  let sslRenewalRunning = false;
  const runScheduledSslRenewal = async (force = false): Promise<void> => {
    const project = projectContext.current();
    if (!project || sslRenewalRunning) return;
    const settings = await settingsService.get();
    if (!settings.ok || !projectContext.isCurrent(project)) return;
    const interval = settings.value.ssl.checkIntervalHours * 60 * 60_000;
    if (!force && Date.now() - (lastSslCheck.get(project.projectId) ?? 0) < interval) return;

    sslRenewalRunning = true;
    lastSslCheck.set(project.projectId, Date.now());
    /*
     * Registered as abortable, which here means "wait for me", not "refuse".
     *
     * A non-abortable operation is a blocker: `deactivate` throws rather than
     * let late state reach another workspace, which is right for a Pulumi apply
     * the user started and can see. This is a timer. Registering it the same
     * way meant that every minute, for as long as a renewal sweep took, Lock
     * and Switch failed with "Wait for the active operation to finish" naming
     * an operation the user never started and cannot find — and succeeded again
     * seconds later, which is worse than a consistent failure.
     *
     * `renewDue()` takes no signal, so the abort is a no-op and `deactivate`
     * falls through to awaiting completion. That is the documented teardown
     * contract — wait for or cancel registered work — and it keeps the
     * guarantee that matters: the context is not cleared until the sweep has
     * finished, so nothing it writes can land in the next workspace.
     */
    const operation = projectOperations.begin(
      `ssl-renewal:${project.sessionId}`,
      project.projectId,
      true,
    );
    try {
      await sslService.renewDue();
    } catch (cause) {
      log().error(
        { event: 'ssl.renewal.failed', projectId: project.projectId, err: cause },
        'Scheduled certificate renewal failed',
      );
    } finally {
      operation.complete();
      sslRenewalRunning = false;
    }
  };
  // Poll cheaply; the active project's own setting decides whether work is due.
  const sslRenewalTimer = setInterval(() => void runScheduledSslRenewal(), 60_000);
  sslRenewalTimer.unref();
  setTimeout(() => {
    void runScheduledSslRenewal(true);
  }, 30_000).unref();

  let cloudflareSnapshot = '';
  const synchronizeCloudflareFor = async (
    lease: NonNullable<ReturnType<ProjectContext['current']>>,
  ): Promise<{ warnings: readonly string[] }> => {
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
    if (projectContext.isCurrent(lease)) cloudflareSnapshot = next;
    return { warnings: [] };
  };
  let cloudflareSyncRunning = false;
  const synchronizeCloudflare = async (): Promise<{ warnings: readonly string[] }> => {
    const lease = projectContext.current();
    if (!lease) return { warnings: [] };
    if (cloudflareSyncRunning)
      return { warnings: ['Cloudflare synchronization is already active'] };
    cloudflareSyncRunning = true;
    const operation = projectOperations.begin(
      `cloudflare-sync:${lease.sessionId}`,
      lease.projectId,
      false,
    );
    try {
      return await synchronizeCloudflareFor(lease);
    } finally {
      operation.complete();
      cloudflareSyncRunning = false;
    }
  };
  const lastCloudflareSync = new Map<string, number>();
  const runScheduledCloudflareSync = async (force = false): Promise<void> => {
    const lease = projectContext.current();
    if (!lease || cloudflareSyncRunning) return;
    const settings = await settingsService.get();
    if (!settings.ok || !projectContext.isCurrent(lease)) return;
    const interval = settings.value.cloudflare.autoRefreshMinutes * 60_000;
    if (!force && Date.now() - (lastCloudflareSync.get(lease.projectId) ?? 0) < interval) return;
    lastCloudflareSync.set(lease.projectId, Date.now());
    try {
      const result = await synchronizeCloudflare();
      if (result.warnings.length > 0) {
        log().warn(
          {
            event: 'cloudflare.sync.warning',
            projectId: lease.projectId,
            warnings: result.warnings,
          },
          'Scheduled Cloudflare synchronization completed with warnings',
        );
      }
    } catch (cause) {
      log().error(
        { event: 'cloudflare.sync.failed', projectId: lease.projectId, err: cause },
        'Scheduled Cloudflare synchronization failed',
      );
    }
  };
  const cloudflareSyncTimer = setInterval(() => void runScheduledCloudflareSync(), 60_000);
  cloudflareSyncTimer.unref();

  const synchronizeActiveProject = async (): Promise<{ warnings: readonly string[] }> => {
    const lease = projectContext.requireActive();
    const [targets, cloudflare] = await Promise.all([
      reconcileManagedTargets(
        lease.projectId,
        projectService,
        infrastructureService,
        vpsTargetService,
      ),
      synchronizeCloudflare(),
    ]);
    return projectContext.isCurrent(lease)
      ? { warnings: [...targets.warnings, ...cloudflare.warnings] }
      : { warnings: ['Project changed before synchronization completed'] };
  };
  const projectSessionService = new ProjectSessionService(
    projectRepository,
    projectPasskeys,
    projectContext,
    {
      beforeDeactivate: async (lease) => {
        await projectOperations.deactivate(lease.projectId);
        sshTerminalService.closeAll();
        await removeMaterializedProjectKeys(lease.projectId);
        cloudflareSnapshot = '';
        setActiveLogProject(null);
      },
      afterActivate: async (lease) => {
        setActiveLogProject(lease.projectId);
        // Load each project's own automation schedule after its context is active.
        void runScheduledSslRenewal(true);
        void runScheduledCloudflareSync(true);
        const recoveredDeployments = unwrap(await deploymentService.recoverInterrupted());
        if (recoveredDeployments > 0) {
          log().warn(
            {
              event: 'deploy.recovered',
              count: recoveredDeployments,
              projectId: lease.projectId,
            },
            'Marked interrupted project deployments as failed',
          );
        }
        const synchronized = await synchronizeActiveProject();
        if (synchronized.warnings.length > 0) {
          log().warn(
            {
              event: 'project.synchronize.warnings',
              projectId: lease.projectId,
              warnings: synchronized.warnings,
            },
            'Project activated with synchronization warnings',
          );
        }
      },
    },
  );

  container = {
    projectService,
    projectContext,
    projectSessionService,
    projectConfigurationService,
    projectDuplicationService,
    credentialService,
    settingsService,
    systemSettingsService,
    providerService,
    infrastructureService,
    deploymentService,
    activityService,
    pluginService,
    sshKeyService,
    containerManager,
    containerService,
    runtimePlanService,
    ansibleManager,
    vpsTargetService,
    nginxService,
    hostFirewallService,
    sslService,
    sshTerminalService,
    cloudflareService,
    cloudflareDnsAutomationService,
    jenkinsPipelineService,
    secretsBackedByOsKeychain: cipher.backedByOsKeychain,
    synchronizeData: synchronizeActiveProject,
    snapshotDatabase: async (destination) => {
      await db.$executeRawUnsafe('VACUUM INTO ?', destination);
    },
    snapshotProjectDatabase: async (destination, projectId) => {
      await db.$executeRawUnsafe('VACUUM INTO ?', destination);
      const snapshot = createPrismaClient(toSqliteUrl(destination));
      await snapshot.$connect();
      try {
        await isolateProjectSnapshot(snapshot, projectId);
      } finally {
        await snapshot.$disconnect();
      }
    },
    restoreProjectDatabase: async (source, projectId) => {
      const snapshot = createPrismaClient(toSqliteUrl(source));
      await snapshot.$connect();
      try {
        await restoreProjectSnapshot(db, snapshot, projectId);
      } finally {
        await snapshot.$disconnect();
      }
    },
    exportProjectSecrets: async (projectId) => {
      const [credentials, sshKeys, secrets] = await Promise.all([
        db.credential.findMany({ where: { projectId } }),
        db.sshKey.findMany({ where: { projectId, ciphertext: { not: null } } }),
        db.secret.findMany({ where: { projectId } }),
      ]);
      const decryptAll = (
        rows: readonly { id: string; ciphertext: string | null }[],
      ): Record<string, string> => {
        const output: Record<string, string> = {};
        for (const row of rows) {
          if (!row.ciphertext) continue;
          const decrypted = cipher.decrypt(row.ciphertext);
          if (!decrypted.ok) throw decrypted.error;
          output[row.id] = decrypted.value;
        }
        return output;
      };
      return {
        format: 1,
        credentials: decryptAll(credentials),
        sshKeys: decryptAll(sshKeys),
        secrets: decryptAll(secrets),
      };
    },
    rewrapProjectSecrets: async (projectId, secrets) => {
      const encryptAll = (values: Readonly<Record<string, string>>): Record<string, string> =>
        Object.fromEntries(
          Object.entries(values).map(([id, plaintext]) => {
            const encrypted = cipher.encrypt(plaintext);
            if (!encrypted.ok) throw encrypted.error;
            return [id, encrypted.value];
          }),
        );
      const wrapped = {
        credentials: encryptAll(secrets.credentials),
        sshKeys: encryptAll(secrets.sshKeys),
        secrets: encryptAll(secrets.secrets),
      };
      await db.$transaction(async (tx) => {
        for (const [id, ciphertext] of Object.entries(wrapped.credentials)) {
          const updated = await tx.credential.updateMany({
            where: { id, projectId },
            data: { ciphertext },
          });
          if (updated.count !== 1) throw new Error('A restored credential record is missing');
        }
        for (const [id, ciphertext] of Object.entries(wrapped.sshKeys)) {
          const updated = await tx.sshKey.updateMany({
            where: { id, projectId },
            data: { ciphertext },
          });
          if (updated.count !== 1) throw new Error('A restored SSH key record is missing');
        }
        for (const [id, ciphertext] of Object.entries(wrapped.secrets)) {
          const updated = await tx.secret.updateMany({
            where: { id, projectId },
            data: { ciphertext },
          });
          if (updated.count !== 1) throw new Error('A restored secret record is missing');
        }
      });
    },
    importProjectDatabase: async (source, projectId, passkey, portableSecrets) => {
      const digest = await projectPasskeys.hash(passkey);
      if (!digest.ok) throw digest.error;
      const encryptAll = (values: Readonly<Record<string, string>>): Record<string, string> =>
        Object.fromEntries(
          Object.entries(values).map(([id, plaintext]) => {
            const encrypted = cipher.encrypt(plaintext);
            if (!encrypted.ok) throw encrypted.error;
            return [id, encrypted.value];
          }),
        );
      const wrapped = {
        credentials: encryptAll(portableSecrets.credentials),
        sshKeys: encryptAll(portableSecrets.sshKeys),
        secrets: encryptAll(portableSecrets.secrets),
      };
      const snapshot = createPrismaClient(toSqliteUrl(source));
      await snapshot.$connect();
      try {
        await importProjectSnapshot(db, snapshot, projectId, digest.value, wrapped);
      } finally {
        await snapshot.$disconnect();
      }
    },
    dispose: async () => {
      clearInterval(sslRenewalTimer);
      clearInterval(cloudflareSyncTimer);
      sshTerminalService.closeAll();
      try {
        await clearMaterializedProjectKeyRoot();
      } catch (error) {
        log().warn(
          { err: error, event: 'runtime-keys.cleanup-failed' },
          'Could not remove transient SSH keys during shutdown',
        );
      }
      await db.$disconnect();
      container = null;
    },
  };
  log().info({ event: 'container.ready' }, 'Application services initialised');
  return container;
}

async function reconcileManagedTargets(
  activeProjectId: string,
  projects: ProjectService,
  infrastructure: InfrastructureService,
  targets: VpsTargetService,
): Promise<{ warnings: readonly string[] }> {
  const warnings: string[] = [];
  const [project, stacks] = await Promise.all([
    projects.get(activeProjectId),
    infrastructure.listManagedStacks(),
  ]);
  if (!project.ok) {
    log().warn({ event: 'vps-target.reconcile.skipped' }, 'Could not discover managed stacks');
    warnings.push(project.error.message);
    return { warnings };
  }
  if (!stacks.ok) {
    log().warn({ event: 'vps-target.reconcile.skipped' }, 'Could not discover managed stacks');
    warnings.push(stacks.error.message);
    return { warnings };
  }
  const ref = projectStackReference(project.value);
  const exists = stacks.value.some(
    (stack) => stack.ref.project === ref.project && stack.ref.stack === ref.stack,
  );
  if (!exists) {
    const removed = await targets.removeManagedProject(project.value.id);
    if (!removed.ok) warnings.push(removed.error.message);
    return { warnings };
  }
  const outputs = await infrastructure.outputs(ref, project.value.id);
  if (!outputs.ok) {
    log().warn(
      { event: 'vps-target.reconcile.failed', projectId: project.value.id, err: outputs.error },
      'Could not synchronize managed VPS targets',
    );
    warnings.push(outputs.error.message);
  }
  emitEvent('vpsTargets:changed', { reason: 'synchronized' });
  return { warnings };
}

/** Access the initialised container. Throws if called before {@link initContainer}. */
export function getContainer(): AppContainer {
  if (!container) throw new Error('Application container has not been initialised');
  return container;
}
