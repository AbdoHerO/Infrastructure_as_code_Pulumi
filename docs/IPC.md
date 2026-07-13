# IPC Reference

The renderer never touches Node, the database, Pulumi or SSH directly. It
communicates with the main process exclusively through a **typed IPC contract**
defined once in [`apps/desktop/src/shared/ipc/contract.ts`](../apps/desktop/src/shared/ipc/contract.ts)
and shared by all three processes. This single source of truth keeps the secure
bridge, the main-process handlers and the renderer client in lock-step at compile
time.

## The two communication styles

### 1. Request / response (`invoke`)

Every call resolves to a serialized **`Result` envelope** — expected failures
cross the boundary as data, never as thrown exceptions:

```ts
type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedAppError };
```

- **Main** registers handlers via `registerHandler(channel, handler)`. The
  handler's return value (or a thrown/typed error) is wrapped into the envelope.
- **Preload** exposes one generic method:
  `window.cloudforge.invoke(channel, payload)`.
- **Renderer** uses the helpers in
  [`lib/ipc.ts`](../apps/desktop/src/renderer/src/lib/ipc.ts):
  - `invoke(channel, payload)` → returns the value or **throws** `IpcCallError`
    (idiomatic for TanStack Query).
  - `tryInvoke(channel, payload)` → returns a `Result` (explicit branching).

### 2. Streaming events (`subscribe`)

For long-running operations that emit output over time (Pulumi and deployment
logs), the main process **pushes** events to the renderer. Channels are
**allow-listed** in `IPC_EVENT_CHANNELS`; the preload validates against the list.

- **Main** broadcasts with `emitEvent(channel, payload)`
  ([`main/ipc/emit.ts`](../apps/desktop/src/main/ipc/emit.ts)).
- **Renderer** calls `subscribe(channel, listener)` → returns an unsubscribe fn.
- Payloads carry a **`streamId`** so a caller can correlate a specific run.

| Event channel | Payload                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `engine:log`  | `{ streamId, event: EngineEvent }` — Pulumi preview/apply/destroy output |
| `deploy:log`  | `{ streamId, event: DeployEvent }` — SSH deployment output (per step)    |

## Channel catalogue

All request/response channels, grouped by feature. `void` means no payload.

### App

| Channel       | Request  | Response                                                            |
| ------------- | -------- | ------------------------------------------------------------------- |
| `app:getInfo` | `void`   | `AppInfo` (name, version, platform, arch, locale, runtime versions) |
| `app:ping`    | `string` | `string`                                                            |

### Projects

| Channel           | Request                               | Response       |
| ----------------- | ------------------------------------- | -------------- |
| `projects:list`   | `void`                                | `ProjectDto[]` |
| `projects:get`    | `{ id }`                              | `ProjectDto`   |
| `projects:create` | `CreateProjectInput`                  | `ProjectDto`   |
| `projects:update` | `{ id, changes: UpdateProjectInput }` | `ProjectDto`   |
| `projects:delete` | `{ id }`                              | `void`         |
| `projects:count`  | `void`                                | `number`       |

### Credentials & security

| Channel              | Request                 | Response                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------ |
| `credentials:list`   | `void`                  | `CredentialSummaryDto[]` (metadata only — **never secrets**) |
| `credentials:create` | `CreateCredentialInput` | `CredentialSummaryDto`                                       |
| `credentials:reveal` | `{ id }`                | `RevealedCredentialDto` (decrypted — on explicit request)    |
| `credentials:delete` | `{ id }`                | `void`                                                       |
| `security:status`    | `void`                  | `{ backedByOsKeychain: boolean }`                            |

### Settings

| Channel           | Request         | Response                      |
| ----------------- | --------------- | ----------------------------- |
| `settings:get`    | `void`          | `AppSettings`                 |
| `settings:update` | `SettingsPatch` | `AppSettings` (merged result) |

### Cloud providers

| Channel                             | Request            | Response               |
| ----------------------------------- | ------------------ | ---------------------- |
| `providers:test`                    | `{ credentialId }` | `ConnectionTestResult` |
| `providers:listRegions`             | `{ credentialId }` | `Region[]`             |
| `providers:listShapes`              | `{ credentialId }` | `Shape[]`              |
| `providers:listAvailabilityDomains` | `{ credentialId }` | `AvailabilityDomain[]` |

### Infrastructure

| Channel               | Request                                             | Response                               |
| --------------------- | --------------------------------------------------- | -------------------------------------- |
| `infra:engineStatus`  | `void`                                              | `{ available: boolean }`               |
| `infra:getPlan`       | `{ projectId }`                                     | `InfrastructurePlan \| null`           |
| `infra:savePlan`      | `{ projectId, plan }`                               | `void`                                 |
| `infra:validate`      | `{ plan }`                                          | `PlanIssue[]`                          |
| `infra:preview`       | `{ projectId, streamId }`                           | `PreviewResult` — streams `engine:log` |
| `infra:apply`         | `{ projectId, streamId }`                           | `ApplyResult` — streams `engine:log`   |
| `infra:destroy`       | `{ projectId, streamId }`                           | `void` — streams `engine:log`          |
| `infra:outputs`       | `{ projectId }`                                     | `Record<string, unknown>`              |
| `infra:templates`     | `void`                                              | `InfrastructureTemplateSummary[]`      |
| `infra:applyTemplate` | `{ projectId, templateId, sshPublicKey?, region? }` | `InfrastructurePlan`                   |

### Deployments

| Channel            | Request                                                                                          | Response                               |
| ------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `deploy:templates` | `void`                                                                                           | `DeploymentTemplateSummary[]`          |
| `deploy:list`      | `{ projectId }`                                                                                  | `DeploymentDto[]`                      |
| `deploy:count`     | `void`                                                                                           | `number`                               |
| `deploy:run`       | `{ projectId, templateId, host, port, username, sshCredentialId, appImage?, domain?, streamId }` | `DeploymentDto` — streams `deploy:log` |

### Activity, plugins, updates

| Channel              | Request           | Response                        |
| -------------------- | ----------------- | ------------------------------- |
| `activity:list`      | `{ limit? }`      | `ActivityDto[]`                 |
| `plugins:list`       | `void`            | `PluginListItem[]`              |
| `plugins:install`    | `{ id }`          | `void`                          |
| `plugins:setEnabled` | `{ id, enabled }` | `void`                          |
| `plugins:uninstall`  | `{ id }`          | `void`                          |
| `updates:check`      | `void`            | `{ current, latest, upToDate }` |

## How a call flows

```
Renderer (React)                Preload            Main process
────────────────                ───────            ────────────
invoke('projects:create', dto)
        │ window.cloudforge.invoke ──► ipcRenderer.invoke ──► ipcMain.handle
        │                                                      │
        │                                        registerHandler wraps:
        │                                        ProjectService.create(dto)
        │                                          → Result<ProjectDto>
        │                                        → { ok, value } | { ok:false, error }
        ◄──────────────────────── IpcResult ◄──────────────────┘
   ok  → return value
   err → throw IpcCallError
```

The main-process handlers live in
[`apps/desktop/src/main/ipc/handlers/`](../apps/desktop/src/main/ipc/handlers/)
and are registered once in `ipc/index.ts`. Each handler resolves its dependency
from the [composition root](../apps/desktop/src/main/container.ts) via
`getContainer()` and unwraps service `Result`s with `orThrow` (which re-throws a
typed `AppError` for the registry to serialize).

## Adding a channel (checklist)

1. Add the channel + request/response types to `IpcContract` in `contract.ts`,
   and append the name to `IPC_CHANNELS`. (For a stream, also extend
   `IpcEventContract` + `IPC_EVENT_CHANNELS`.)
2. Add a handler in the relevant `main/ipc/handlers/*.handlers.ts` (or a new
   file) and register it in `main/ipc/index.ts`.
3. Call it from the renderer via `invoke` / `tryInvoke` (usually inside a
   TanStack Query hook under the feature folder).

TypeScript enforces every step: an unknown channel, a mismatched payload or a
missing entry in `IPC_CHANNELS` is a compile error.
