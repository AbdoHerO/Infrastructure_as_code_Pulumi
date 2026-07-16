import type { SerializedAppError } from '@cloudforge/shared';
import type {
  ActivityDto,
  AnsibleEvent,
  AnsibleAccessDetails,
  AnsibleOutcome,
  AnsibleProfile,
  AnsibleProfileState,
  AnsibleProfileId,
  AnsibleStatus,
  AppSettings,
  AvailabilityDomain,
  ApplyResult,
  ConnectionTestResult,
  CloudInstance,
  CloudResource,
  ContainerAction,
  ContainerStats,
  CreateCredentialInput,
  CreateProjectInput,
  CredentialSummaryDto,
  CustomTemplateSummary,
  DeployEvent,
  DeploymentDto,
  DeploymentTemplateSummary,
  EngineEvent,
  InfrastructurePlan,
  InfrastructureTemplateSummary,
  InstanceAction,
  ManagedStackSummary,
  NginxSite,
  ManagedNginxSite,
  NginxBackup,
  NginxEvent,
  NginxLiveStatus,
  NginxLogQuery,
  NginxOperationOutcome,
  NginxOverview,
  PlanIssue,
  PluginListItem,
  PluginManifest,
  PreviewResult,
  ProjectDto,
  Region,
  RemoteContainer,
  RevealedCredentialDto,
  SettingsPatch,
  Shape,
  MachineImage,
  SshKeyAlgorithm,
  SshKeySummary,
  UpdateProjectInput,
  VpsPreflightReport,
  VpsTargetDto,
  InstanceFirewall,
  LiveFirewallRule,
  CertificateDetails,
  CertificateEvent,
  CertificateIssueConfig,
  CloudflareAnalytics,
  CloudflareDashboard,
  CloudflareDnsRecord,
  CloudflareDnsRecordInput,
  CloudflareDnsBatchAction,
  CloudflarePageRule,
  CloudflareRedirectRule,
  CloudflarePlatformSummary,
  CloudflareSecurityOverview,
  CloudflareZone,
  CloudflareZoneSettings,
  ServiceConnection,
  CloudflareDnsPropagation,
  JenkinsPipelineRecord,
  JenkinsJobStatus,
  SaveJenkinsPipelineInput,
} from '@cloudforge/core';

/**
 * The typed IPC contract shared by the main, preload and renderer processes.
 *
 * Every channel declares its `request` and `response` shape. This single source
 * of truth keeps the secure bridge, the main-process handlers and the renderer
 * client in lock-step at compile time.
 */
export interface IpcContract {
  'app:getInfo': { request: void; response: AppInfo };
  'app:ping': { request: string; response: string };
  'app:openExternal': { request: { link: 'github' | 'releases' }; response: void };
  'app:copyDiagnostics': { request: void; response: void };
  'app:copyText': { request: { text: string }; response: void };
  'app:synchronize': { request: void; response: { warnings: readonly string[] } };

  'projects:list': { request: void; response: ProjectDto[] };
  'projects:get': { request: { id: string }; response: ProjectDto };
  'projects:create': { request: CreateProjectInput; response: ProjectDto };
  'projects:update': {
    request: { id: string; changes: UpdateProjectInput };
    response: ProjectDto;
  };
  'projects:delete': { request: { id: string }; response: void };
  'projects:count': { request: void; response: number };

  'credentials:list': { request: void; response: CredentialSummaryDto[] };
  'credentials:create': { request: CreateCredentialInput; response: CredentialSummaryDto };
  'credentials:reveal': { request: { id: string }; response: RevealedCredentialDto };
  'credentials:delete': { request: { id: string }; response: void };

  'settings:get': { request: void; response: AppSettings };
  'settings:update': { request: SettingsPatch; response: AppSettings };

  'cloudflare:test': { request: { credentialId: string }; response: ServiceConnection };
  'cloudflare:dashboard': {
    request: { credentialId: string; zoneId?: string };
    response: CloudflareDashboard;
  };
  'cloudflare:zones': { request: { credentialId: string }; response: readonly CloudflareZone[] };
  'cloudflare:createZone': {
    request: { credentialId: string; name: string; accountId?: string };
    response: CloudflareZone;
  };
  'cloudflare:deleteZone': {
    request: { credentialId: string; zoneId: string };
    response: void;
  };
  'cloudflare:dnsRecords': {
    request: { credentialId: string; zoneId: string };
    response: readonly CloudflareDnsRecord[];
  };
  'cloudflare:createDnsRecord': {
    request: { credentialId: string; zoneId: string; input: CloudflareDnsRecordInput };
    response: CloudflareDnsRecord;
  };
  'cloudflare:updateDnsRecord': {
    request: {
      credentialId: string;
      zoneId: string;
      recordId: string;
      input: CloudflareDnsRecordInput;
    };
    response: CloudflareDnsRecord;
  };
  'cloudflare:deleteDnsRecord': {
    request: { credentialId: string; zoneId: string; recordId: string };
    response: void;
  };
  'cloudflare:batchDnsRecords': {
    request: { credentialId: string; zoneId: string; action: CloudflareDnsBatchAction };
    response: { changed: number };
  };
  'cloudflare:ensureDns': {
    request: {
      credentialId?: string;
      zoneId?: string;
      domain: string;
      expectedIp: string;
    };
    response: CloudflareDnsPropagation;
  };
  'cloudflare:verifyDns': {
    request: {
      credentialId?: string;
      zoneId?: string;
      domain: string;
      expectedIp: string;
    };
    response: CloudflareDnsPropagation;
  };
  'cloudflare:zoneSettings': {
    request: { credentialId: string; zoneId: string };
    response: CloudflareZoneSettings;
  };
  'cloudflare:updateZoneSettings': {
    request: { credentialId: string; zoneId: string; patch: Partial<CloudflareZoneSettings> };
    response: CloudflareZoneSettings;
  };
  'cloudflare:purgeCache': {
    request: { credentialId: string; zoneId: string };
    response: void;
  };
  'cloudflare:security': {
    request: { credentialId: string; zoneId: string };
    response: CloudflareSecurityOverview;
  };
  'cloudflare:analytics': {
    request: { credentialId: string; zoneId: string; since: string; until: string };
    response: CloudflareAnalytics;
  };
  'cloudflare:pageRules': {
    request: { credentialId: string; zoneId: string };
    response: readonly CloudflarePageRule[];
  };
  'cloudflare:savePageRule': {
    request: {
      credentialId: string;
      zoneId: string;
      rule: CloudflarePageRule | Omit<CloudflarePageRule, 'id'>;
    };
    response: CloudflarePageRule;
  };
  'cloudflare:deletePageRule': {
    request: { credentialId: string; zoneId: string; ruleId: string };
    response: void;
  };
  'cloudflare:redirectRules': {
    request: { credentialId: string; zoneId: string };
    response: readonly CloudflareRedirectRule[];
  };
  'cloudflare:saveRedirectRule': {
    request: {
      credentialId: string;
      zoneId: string;
      rule: CloudflareRedirectRule | Omit<CloudflareRedirectRule, 'id'>;
    };
    response: CloudflareRedirectRule;
  };
  'cloudflare:deleteRedirectRule': {
    request: { credentialId: string; zoneId: string; ruleId: string };
    response: void;
  };
  'cloudflare:platform': {
    request: { credentialId: string; zoneId: string; accountId: string };
    response: CloudflarePlatformSummary;
  };

  'jenkins:list': { request: void; response: JenkinsPipelineRecord[] };
  'jenkins:test': {
    request: { targetId: string; credentialId: string };
    response: { version: string };
  };
  'jenkins:save': { request: SaveJenkinsPipelineInput; response: JenkinsPipelineRecord };
  'jenkins:delete': { request: { id: string }; response: void };
  'jenkins:trigger': {
    request: { id: string; parameters: Readonly<Record<string, string>> };
    response: void;
  };
  'jenkins:status': { request: { id: string }; response: JenkinsJobStatus };

  'security:status': { request: void; response: { backedByOsKeychain: boolean } };
  'backup:create': { request: { passphrase: string }; response: { path: string | null } };
  'backup:restore': { request: { passphrase: string }; response: { restored: boolean } };

  'sshKeys:list': { request: void; response: SshKeySummary[] };
  'sshKeys:generate': {
    request: { name: string; algorithm: SshKeyAlgorithm; passphrase?: string };
    response: SshKeySummary;
  };
  'sshKeys:import': {
    request: { name: string; privateKey: string; passphrase?: string };
    response: SshKeySummary;
  };
  'sshKeys:revealPrivate': { request: { id: string }; response: { privateKey: string } };
  'sshKeys:exportPrivate': {
    request: { id: string; suggestedName: string };
    response: { path: string | null };
  };
  'sshKeys:materializePrivate': {
    request: { id: string; suggestedName: string };
    response: { path: string };
  };
  'sshKeys:delete': { request: { id: string }; response: void };

  'providers:test': { request: { credentialId: string }; response: ConnectionTestResult };
  'providers:listRegions': { request: { credentialId: string }; response: Region[] };
  'providers:listShapes': { request: { credentialId: string }; response: Shape[] };
  'providers:listImages': { request: { credentialId: string }; response: MachineImage[] };
  'providers:listAvailabilityDomains': {
    request: { credentialId: string };
    response: AvailabilityDomain[];
  };
  'providers:listInstances': { request: { credentialId: string }; response: CloudInstance[] };
  'providers:listResources': { request: { credentialId: string }; response: CloudResource[] };
  'providers:instanceAction': {
    request: { credentialId: string; instanceId: string; action: InstanceAction };
    response: CloudInstance;
  };
  'providers:terminateInstance': {
    request: { credentialId: string; instanceId: string };
    response: void;
  };
  'firewall:get': {
    request: { credentialId: string; instanceId: string };
    response: InstanceFirewall;
  };
  'firewall:update': {
    request: {
      credentialId: string;
      instanceId: string;
      expectedRules: LiveFirewallRule[];
      rules: LiveFirewallRule[];
    };
    response: InstanceFirewall;
  };

  'infra:engineStatus': { request: void; response: { available: boolean } };
  'infra:getPlan': { request: { projectId: string }; response: InfrastructurePlan | null };
  'infra:savePlan': { request: { projectId: string; plan: InfrastructurePlan }; response: void };
  'infra:validate': { request: { plan: InfrastructurePlan }; response: PlanIssue[] };
  'infra:preview': {
    request: { projectId: string; streamId: string };
    response: PreviewResult;
  };
  'infra:apply': {
    request: { projectId: string; streamId: string; previewToken: string };
    response: ApplyResult;
  };
  'infra:destroy': { request: { projectId: string; streamId: string }; response: void };
  'infra:refresh': { request: { projectId: string; streamId: string }; response: void };
  'infra:outputs': { request: { projectId: string }; response: Record<string, unknown> };
  'infra:managedStacks': { request: void; response: ManagedStackSummary[] };
  'infra:destroyStack': {
    request: { ref: { project: string; stack: string }; streamId: string };
    response: void;
  };

  'deploy:templates': { request: void; response: DeploymentTemplateSummary[] };
  'deploy:list': { request: { projectId: string }; response: DeploymentDto[] };
  'deploy:count': { request: void; response: number };
  'deploy:inspectHostKey': {
    request: { host: string; port: number };
    response: { fingerprint: string };
  };
  'deploy:cancel': { request: { streamId: string }; response: void };
  'deploy:run': {
    request: {
      projectId: string;
      templateId: string;
      host: string;
      port: number;
      username: string;
      sshCredentialId: string;
      hostKeySha256: string;
      appImage?: string;
      domain?: string;
      streamId: string;
    };
    response: DeploymentDto;
  };

  'containers:list': { request: ContainerTargetRequest; response: RemoteContainer[] };
  'containers:action': {
    request: ContainerTargetRequest & { containerId: string; action: ContainerAction };
    response: void;
  };
  'containers:logs': {
    request: ContainerTargetRequest & { containerId: string; lines?: number };
    response: { text: string };
  };
  'containers:stats': {
    request: ContainerTargetRequest & { containerId: string };
    response: ContainerStats;
  };
  'containers:deployCompose': {
    request: ContainerTargetRequest & { projectName: string; composeYaml: string };
    response: void;
  };

  'terminal:open': {
    request: { targetId: string; sessionId: string; columns: number; rows: number };
    response: void;
  };
  'terminal:write': { request: { sessionId: string; data: string }; response: void };
  'terminal:resize': {
    request: { sessionId: string; columns: number; rows: number };
    response: void;
  };
  'terminal:close': { request: { sessionId: string }; response: void };

  'ansible:profiles': { request: void; response: AnsibleProfile[] };
  'ansible:targets': { request: void; response: VpsTargetDto[] };
  'ansible:createTarget': { request: SaveVpsTargetRequest; response: VpsTargetDto };
  'ansible:updateTarget': {
    request: SaveVpsTargetRequest & { id: string };
    response: VpsTargetDto;
  };
  'ansible:deleteTarget': { request: { id: string }; response: void };
  'ansible:inspectHostKey': {
    request: { host: string; port: number };
    response: { fingerprint: string };
  };
  'ansible:status': { request: SshTargetRequest; response: AnsibleStatus };
  'ansible:profileStates': {
    request: SshTargetRequest;
    response: readonly AnsibleProfileState[];
  };
  'ansible:preflight': {
    request: SshTargetRequest & {
      targetId?: string;
      profileId?: AnsibleProfileId;
      variables?: Record<string, unknown>;
    };
    response: VpsPreflightReport;
  };
  'ansible:repair': {
    request: SshTargetRequest & { targetId?: string; streamId: string };
    response: VpsPreflightReport;
  };
  'ansible:bootstrap': {
    request: SshTargetRequest & { streamId: string };
    response: AnsibleStatus;
  };
  'ansible:run': {
    request: SshTargetRequest & {
      profileId: AnsibleProfileId;
      variables: Record<string, unknown>;
      streamId: string;
    };
    response: AnsibleOutcome;
  };
  'ansible:jenkinsAction': {
    request: SshTargetRequest & {
      action: 'verify' | 'restart';
      streamId: string;
    };
    response: AnsibleOutcome;
  };
  'ansible:access': {
    request: SshTargetRequest & {
      profileId: AnsibleProfileId;
      variables: Record<string, unknown>;
    };
    response: AnsibleAccessDetails | null;
  };
  'ansible:cancel': { request: { streamId: string }; response: void };
  'ansible:nginxSites': { request: SshTargetRequest; response: NginxSite[] };
  'ansible:nginxUpsert': {
    request: SshTargetRequest & { site: NginxSite; streamId: string };
    response: AnsibleOutcome;
  };
  'ansible:nginxRemove': {
    request: SshTargetRequest & { domain: string; streamId: string };
    response: AnsibleOutcome;
  };

  'nginx:inspect': { request: { targetId: string }; response: NginxOverview };
  'nginx:listSites': { request: { targetId: string }; response: ManagedNginxSite[] };
  'nginx:saveSite': {
    request: { targetId: string; site: ManagedNginxSite; streamId: string };
    response: NginxOperationOutcome;
  };
  'nginx:removeSite': {
    request: { targetId: string; domain: string; streamId: string };
    response: NginxOperationOutcome;
  };
  'nginx:readConfig': { request: { targetId: string }; response: { content: string } };
  'nginx:saveConfig': {
    request: { targetId: string; content: string; streamId: string };
    response: NginxOperationOutcome;
  };
  'nginx:reload': {
    request: { targetId: string; streamId: string };
    response: NginxOperationOutcome;
  };
  'nginx:liveStatus': { request: { targetId: string }; response: NginxLiveStatus };
  'nginx:logs': {
    request: { targetId: string; query: NginxLogQuery };
    response: { lines: string[] };
  };
  'nginx:backups': { request: { targetId: string }; response: NginxBackup[] };
  'nginx:readBackupConfig': {
    request: { targetId: string; backupId: string };
    response: { content: string };
  };
  'nginx:restore': {
    request: { targetId: string; backupId: string; streamId: string };
    response: NginxOperationOutcome;
  };
  'ssl:verifyDns': {
    request: { targetId: string; domain: string };
    response: {
      domainIps: readonly string[];
      targetIps: readonly string[];
      matches: boolean;
      status: 'pending' | 'propagated' | 'error';
      provider: 'cloudflare' | 'public-dns';
      proxied: boolean;
      sslMode: string;
      certificateRequirement: 'required' | 'recommended';
      message: string;
    };
  };
  'ssl:list': {
    request: { targetId: string; certificateVolume: string };
    response: CertificateDetails[];
  };
  'ssl:issue': {
    request: { targetId: string; config: CertificateIssueConfig; streamId: string };
    response: CertificateDetails;
  };
  'ssl:export': {
    request: {
      targetId: string;
      certificateVolume: string;
      domain: string;
      format: 'pem' | 'crt' | 'key' | 'zip';
    };
    response: { name: string; contentBase64: string };
  };

  'activity:list': { request: { limit?: number }; response: ActivityDto[] };

  'infra:templates': { request: void; response: InfrastructureTemplateSummary[] };
  'infra:applyTemplate': {
    request: {
      projectId: string;
      templateId: string;
      sshPublicKey?: string;
      sshCredentialId?: string;
      region?: string;
    };
    response: InfrastructurePlan;
  };
  'infra:customTemplates': { request: void; response: CustomTemplateSummary[] };
  'infra:saveTemplate': {
    request: { name: string; description?: string; plan: InfrastructurePlan };
    response: CustomTemplateSummary;
  };
  'infra:deleteTemplate': { request: { id: string }; response: void };
  'infra:applyCustomTemplate': {
    request: { projectId: string; templateId: string };
    response: InfrastructurePlan;
  };

  'plugins:list': { request: void; response: PluginListItem[] };
  'plugins:active': { request: void; response: PluginManifest[] };
  'plugins:install': { request: { id: string }; response: void };
  'plugins:setEnabled': { request: { id: string; enabled: boolean }; response: void };
  'plugins:uninstall': { request: { id: string }; response: void };

  'updates:state': { request: void; response: UpdateState };
  'updates:check': { request: void; response: UpdateState };
  'updates:download': { request: void; response: UpdateState };
  'updates:install': { request: void; response: void };

  'logs:info': { request: void; response: { path: string; dir: string } };
  'logs:tail': { request: { lines?: number }; response: string[] };
  'logs:openFolder': { request: void; response: void };
  'logs:report': {
    request: {
      level: 'error' | 'warn' | 'info';
      message: string;
      stack?: string;
      source?: string;
    };
    response: void;
  };
}

/**
 * Fire-and-forget events pushed from the main process to the renderer (as
 * opposed to request/response `invoke`). Correlated by `streamId`.
 */
export interface IpcEventContract {
  'engine:log': { streamId: string; event: EngineEvent };
  'deploy:log': { streamId: string; event: DeployEvent };
  'ansible:log': { streamId: string; event: AnsibleEvent };
  'nginx:log': { streamId: string; event: NginxEvent };
  'ssl:log': { streamId: string; event: CertificateEvent };
  'updates:state': UpdateState;
  'vpsTargets:changed': { reason: 'created' | 'updated' | 'deleted' | 'synchronized' };
  'cloudflare:changed': {
    reason:
      | 'zone-added'
      | 'zone-deleted'
      | 'dns-changed'
      | 'security-changed'
      | 'ssl-changed'
      | 'cache-changed'
      | 'synchronized';
  };
  'terminal:data': { sessionId: string; data: string };
  'terminal:closed': { sessionId: string; reason?: string };
}

export type IpcEventChannel = keyof IpcEventContract;
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C];

/** Runtime-iterable list of event channels (allow-list for the bridge). */
export const IPC_EVENT_CHANNELS = [
  'engine:log',
  'deploy:log',
  'ansible:log',
  'nginx:log',
  'ssl:log',
  'updates:state',
  'vpsTargets:changed',
  'cloudflare:changed',
  'terminal:data',
  'terminal:closed',
] as const satisfies readonly IpcEventChannel[];

/** Union of all valid IPC channel names. */
export type IpcChannel = keyof IpcContract;

/** Request payload type for a given channel. */
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];

/** Response payload type for a given channel. */
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

/**
 * Every IPC call resolves to a serialized {@link Result} envelope so that
 * expected failures cross the process boundary as data, never thrown values.
 */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedAppError };

export interface SshTargetRequest {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly sshCredentialId: string;
  readonly hostKeySha256: string;
}

export interface SaveVpsTargetRequest extends SshTargetRequest {
  readonly name: string;
}

export type ContainerTargetRequest = SshTargetRequest;

export type UpdateStatus =
  'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateState {
  readonly status: UpdateStatus;
  readonly current: string;
  readonly latest: string | null;
  readonly progress?: number;
  readonly message?: string;
}

/** Runtime information about the running application and host. */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly locale: string;
  readonly packaged: boolean;
  readonly build: {
    readonly number: string;
    readonly commit: string;
    readonly builtAt: string;
  };
  readonly os: {
    readonly type: string;
    readonly release: string;
  };
  readonly versions: {
    readonly electron: string;
    readonly node: string;
    readonly chrome: string;
  };
}

/** All channel names as a runtime-iterable list (kept in sync with the contract). */
export const IPC_CHANNELS = [
  'app:getInfo',
  'app:ping',
  'app:openExternal',
  'app:copyDiagnostics',
  'app:copyText',
  'app:synchronize',
  'projects:list',
  'projects:get',
  'projects:create',
  'projects:update',
  'projects:delete',
  'projects:count',
  'credentials:list',
  'credentials:create',
  'credentials:reveal',
  'credentials:delete',
  'settings:get',
  'settings:update',
  'cloudflare:test',
  'cloudflare:dashboard',
  'cloudflare:zones',
  'cloudflare:createZone',
  'cloudflare:deleteZone',
  'cloudflare:dnsRecords',
  'cloudflare:createDnsRecord',
  'cloudflare:updateDnsRecord',
  'cloudflare:deleteDnsRecord',
  'cloudflare:batchDnsRecords',
  'cloudflare:ensureDns',
  'cloudflare:verifyDns',
  'cloudflare:zoneSettings',
  'cloudflare:updateZoneSettings',
  'cloudflare:purgeCache',
  'cloudflare:security',
  'cloudflare:analytics',
  'cloudflare:pageRules',
  'cloudflare:savePageRule',
  'cloudflare:deletePageRule',
  'cloudflare:redirectRules',
  'cloudflare:saveRedirectRule',
  'cloudflare:deleteRedirectRule',
  'cloudflare:platform',
  'jenkins:list',
  'jenkins:test',
  'jenkins:save',
  'jenkins:delete',
  'jenkins:trigger',
  'jenkins:status',
  'security:status',
  'backup:create',
  'backup:restore',
  'sshKeys:list',
  'sshKeys:generate',
  'sshKeys:import',
  'sshKeys:revealPrivate',
  'sshKeys:exportPrivate',
  'sshKeys:materializePrivate',
  'sshKeys:delete',
  'providers:test',
  'providers:listRegions',
  'providers:listShapes',
  'providers:listImages',
  'providers:listAvailabilityDomains',
  'providers:listInstances',
  'providers:listResources',
  'providers:instanceAction',
  'providers:terminateInstance',
  'firewall:get',
  'firewall:update',
  'infra:engineStatus',
  'infra:getPlan',
  'infra:savePlan',
  'infra:validate',
  'infra:preview',
  'infra:apply',
  'infra:destroy',
  'infra:refresh',
  'infra:outputs',
  'infra:managedStacks',
  'infra:destroyStack',
  'deploy:templates',
  'deploy:list',
  'deploy:count',
  'deploy:inspectHostKey',
  'deploy:cancel',
  'deploy:run',
  'containers:list',
  'containers:action',
  'containers:logs',
  'containers:stats',
  'containers:deployCompose',
  'ansible:profiles',
  'ansible:targets',
  'ansible:createTarget',
  'ansible:updateTarget',
  'ansible:deleteTarget',
  'ansible:inspectHostKey',
  'ansible:status',
  'ansible:preflight',
  'ansible:repair',
  'ansible:bootstrap',
  'ansible:run',
  'ansible:jenkinsAction',
  'ansible:access',
  'ansible:cancel',
  'ansible:nginxSites',
  'ansible:nginxUpsert',
  'ansible:nginxRemove',
  'nginx:inspect',
  'nginx:listSites',
  'nginx:saveSite',
  'nginx:removeSite',
  'nginx:readConfig',
  'nginx:saveConfig',
  'nginx:reload',
  'nginx:liveStatus',
  'nginx:logs',
  'nginx:backups',
  'nginx:readBackupConfig',
  'nginx:restore',
  'ssl:verifyDns',
  'ssl:list',
  'ssl:issue',
  'ssl:export',
  'activity:list',
  'infra:templates',
  'infra:applyTemplate',
  'infra:customTemplates',
  'infra:saveTemplate',
  'infra:deleteTemplate',
  'infra:applyCustomTemplate',
  'plugins:list',
  'plugins:active',
  'plugins:install',
  'plugins:setEnabled',
  'plugins:uninstall',
  'updates:check',
  'updates:state',
  'updates:download',
  'updates:install',
  'logs:info',
  'logs:tail',
  'logs:openFolder',
  'logs:report',
] as const satisfies readonly IpcChannel[];
