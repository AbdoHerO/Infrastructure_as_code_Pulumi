import type { SerializedAppError } from '@cloudforge/shared';
import type { CreateProjectInput, ProjectDto, UpdateProjectInput } from '@cloudforge/core';

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
}

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
] as const satisfies readonly IpcChannel[];
