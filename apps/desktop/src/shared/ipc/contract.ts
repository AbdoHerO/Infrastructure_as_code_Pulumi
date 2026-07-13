import type { SerializedAppError } from '@cloudforge/shared';
import type {
  AppSettings,
  AvailabilityDomain,
  ApplyResult,
  ConnectionTestResult,
  CreateCredentialInput,
  CreateProjectInput,
  CredentialSummaryDto,
  EngineEvent,
  InfrastructurePlan,
  PlanIssue,
  PreviewResult,
  ProjectDto,
  Region,
  RevealedCredentialDto,
  SettingsPatch,
  Shape,
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

  'providers:test': { request: { credentialId: string }; response: ConnectionTestResult };
  'providers:listRegions': { request: { credentialId: string }; response: Region[] };
  'providers:listShapes': { request: { credentialId: string }; response: Shape[] };
  'providers:listAvailabilityDomains': {
    request: { credentialId: string };
    response: AvailabilityDomain[];
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
  'infra:outputs': { request: { projectId: string }; response: Record<string, unknown> };
}

/**
 * Fire-and-forget events pushed from the main process to the renderer (as
 * opposed to request/response `invoke`). Correlated by `streamId`.
 */
export interface IpcEventContract {
  'engine:log': { streamId: string; event: EngineEvent };
}

export type IpcEventChannel = keyof IpcEventContract;
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C];

/** Runtime-iterable list of event channels (allow-list for the bridge). */
export const IPC_EVENT_CHANNELS = ['engine:log'] as const satisfies readonly IpcEventChannel[];

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
  'providers:test',
  'providers:listRegions',
  'providers:listShapes',
  'providers:listAvailabilityDomains',
  'infra:engineStatus',
  'infra:getPlan',
  'infra:savePlan',
  'infra:validate',
  'infra:preview',
  'infra:apply',
  'infra:destroy',
  'infra:outputs',
] as const satisfies readonly IpcChannel[];
