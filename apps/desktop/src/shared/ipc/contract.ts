import type { SerializedAppError } from '@cloudforge/shared';
import type {
  ActivityDto,
  AnsibleEvent,
  AnsibleOutcome,
  AnsibleProfile,
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
  SshKeyAlgorithm,
  SshKeySummary,
  UpdateProjectInput,
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

  'security:status': { request: void; response: { backedByOsKeychain: boolean } };
  'backup:create': { request: void; response: { path: string | null } };
  'backup:restore': { request: void; response: { restored: boolean } };

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
  'sshKeys:delete': { request: { id: string }; response: void };

  'providers:test': { request: { credentialId: string }; response: ConnectionTestResult };
  'providers:listRegions': { request: { credentialId: string }; response: Region[] };
  'providers:listShapes': { request: { credentialId: string }; response: Shape[] };
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

  'infra:engineStatus': { request: void; response: { available: boolean } };
  'infra:getPlan': { request: { projectId: string }; response: InfrastructurePlan | null };
  'infra:savePlan': { request: { projectId: string; plan: InfrastructurePlan }; response: void };
  'infra:validate': { request: { plan: InfrastructurePlan }; response: PlanIssue[] };
  'infra:preview': {
    request: { projectId: string; streamId: string };
    response: PreviewResult;
  };
  'infra:apply': { request: { projectId: string; streamId: string }; response: ApplyResult };
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

  'ansible:profiles': { request: void; response: AnsibleProfile[] };
  'ansible:inspectHostKey': {
    request: { host: string; port: number };
    response: { fingerprint: string };
  };
  'ansible:status': { request: SshTargetRequest; response: AnsibleStatus };
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

  'activity:list': { request: { limit?: number }; response: ActivityDto[] };

  'infra:templates': { request: void; response: InfrastructureTemplateSummary[] };
  'infra:applyTemplate': {
    request: { projectId: string; templateId: string; sshPublicKey?: string; region?: string };
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
  'updates:state': UpdateState;
}

export type IpcEventChannel = keyof IpcEventContract;
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C];

/** Runtime-iterable list of event channels (allow-list for the bridge). */
export const IPC_EVENT_CHANNELS = [
  'engine:log',
  'deploy:log',
  'ansible:log',
  'updates:state',
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
  'security:status',
  'backup:create',
  'backup:restore',
  'sshKeys:list',
  'sshKeys:generate',
  'sshKeys:import',
  'sshKeys:revealPrivate',
  'sshKeys:delete',
  'providers:test',
  'providers:listRegions',
  'providers:listShapes',
  'providers:listAvailabilityDomains',
  'providers:listInstances',
  'providers:listResources',
  'providers:instanceAction',
  'providers:terminateInstance',
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
  'ansible:inspectHostKey',
  'ansible:status',
  'ansible:bootstrap',
  'ansible:run',
  'ansible:cancel',
  'ansible:nginxSites',
  'ansible:nginxUpsert',
  'ansible:nginxRemove',
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
