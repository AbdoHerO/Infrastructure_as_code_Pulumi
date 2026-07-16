# Phase 0 — Domain & Database Inventory

## Shared kernel (`packages/shared`)
- **`Result<T,E>`** — `ok/err` + `isOk/isErr/map/mapErr/andThen/unwrapOr/unwrap/match/
  fromThrowable/fromPromise/all`. Expected failures flow as values; exceptions only for
  unrecoverable faults.
- **`AppError`** hierarchy — 16 codes: `VALIDATION, NOT_FOUND, CONFLICT, UNAUTHORIZED, FORBIDDEN,
  TIMEOUT, CANCELLED, PROVIDER, SERVICE_PROVIDER, INFRASTRUCTURE, DEPLOYMENT, CREDENTIAL,
  ENCRYPTION, PERSISTENCE, IPC, UNKNOWN`. All carry `context`, recursive `cause`, IPC-safe
  `toJSON()`. `toAppError()` normalizes anything thrown.
- **Branding/identity** — `Brand<T,B>` nominal types, `Uuid` + `newUuid()` (crypto.randomUUID),
  `IsoDateString`, `Page<T>`, `DeepReadonly`, `Loadable`.

## Domain layer (`packages/core/src/domain`)
Only **two aggregate classes**; everything else is value objects / typed unions / flat records.

| Item | Detail |
|---|---|
| `Project` aggregate | `create()` (validates: name ≤100, environment ∈ development/staging/production, region non-empty; tags normalized) · `reconstitute()` · `update()` · `toSnapshot()`. Statuses: draft/provisioning/active/error/destroying/destroyed |
| `Credential` aggregate | `create()` validates fields against `CREDENTIAL_SCHEMAS[kind]` · holds **plaintext** data; encryption happens in CredentialService via `SecretCipher` port |
| `CREDENTIAL_SCHEMAS` | 12 kinds (oracle, aws, azure, github, jenkins, cloudflare, openai, anthropic, dockerhub, gitlab, ssh, ssh-password) — single source of truth for UI forms AND domain validation |
| `PROVIDER_KINDS` | 10 kinds; `PROVISIONING_PROVIDER_KINDS = ['oracle','aws']` only |
| `PluginManifest` | 5 plugin kinds; declarative contribution (`theme:nord`) |
| `Entity<Id>` base | identity equality |

**No domain entities exist for**: Provider, Deployment, VpsTarget, JenkinsPipeline, Activity,
Template, Plan — these are flat `*Record` DTOs defined in application ports.

## Prisma schema (`packages/database/prisma/schema.prisma`) — SQLite, 13 models

**No migrations directory.** Schema materialized by `bootstrap.sql` (generated via
`prisma migrate diff`, executed by `ensureSchema()`) + `migrateSchema()` (idempotent in-place
upgrades; rebuilds legacy Project FK Provider→Credential with a pre-rebuild DB file backup).
No enums (strings), JSON stored as TEXT, no `version` columns, no soft deletes.

| Model | Key fields | Relations / notes |
|---|---|---|
| **Project** | name, environment, region, providerId?, templateId?, status, tags(JSON), variables(JSON) | providerId → **Credential** (SetNull); has deployments, sshKeys, activities. `@@index(updatedAt)` |
| **Provider** | kind, name, status, metadata | **orphan table** — no repository, no domain entity |
| **Credential** | kind, name, **ciphertext**, providerId? | → Provider (SetNull). Never plaintext |
| **VpsTarget** | name, host, port, username, sshCredentialId?, hostKeySha256, lastPreflight(JSON), managedProjectId?, managedResourceName? | `@@unique(managedProjectId, managedResourceName)` |
| **JenkinsPipeline** | name, folder, targetId, jenkinsCredentialId, githubCredentialId?, repositoryUrl, branch, jenkinsfilePath, pipelineScript, definitionMode(scm\|inline), parameters(JSON), environment(JSON), domain, applicationPort?, cloudflareCredentialId?, cloudflareZoneId?, configureDomain, lastStatus | `@@unique(folder, name)`. Repository uses **raw SQL** |
| **Template** | kind('infrastructure'\|'deployment'), name, definition(JSON plan), builtIn | custom infra templates only |
| **Deployment** | projectId, status(pending\|running\|success\|failed), strategy, outputs(JSON), startedAt?, finishedAt? | → Project (Cascade); has LogEntry[] |
| **LogEntry** | deploymentId?, projectId?, level, source, message, metadata | append-only; **no repository accesses it** |
| **SshKey** | projectId?, name, publicKey, ciphertext?, fingerprint | **unused** — keys live in Credential |
| **Secret** | scope, name, ciphertext | `@@unique(scope,name)`; **no repository** |
| **Setting** | key(PK), value | app settings blob + repurposed as PlanStore (`plan:<projectId>`) |
| **Plugin** | name, version, kind, enabled, manifest(JSON) | |
| **Activity** | projectId?, type, message, metadata(JSON), createdAt | append-only audit; `@@index(createdAt)` |

## Repositories (`packages/database/src`) — all return `Result<T, PersistenceError>`

| Repository | Port | Methods |
|---|---|---|
| PrismaProjectRepository | ProjectRepository | findAll, findById, save(upsert), delete, count — maps via `project-mapper` to domain `Project` |
| PrismaCredentialRepository | CredentialRepository | findAll, findById, save, delete (opaque ciphertext records) |
| PrismaSettingsRepository | SettingsRepository | get(key), set(key,value) |
| PrismaActivityRepository | ActivityRepository | create, list(limit clamp 1–1000) |
| PrismaDeploymentRepository | DeploymentRepository | create, update, listByProject, countAll, **failRunning** (crash recovery) |
| PrismaPluginRepository | PluginRepository | listInstalled, upsert, remove |
| PrismaVpsTargetRepository | VpsTargetRepository | list, get, findManaged, create, update, remove, removeManaged*, removeManagedResourcesOutside, removeManagedOutsideProjects (reconciliation) |
| PrismaJenkinsPipelineRepository | JenkinsPipelineRepository | list, get, getByFolderAndName, save (INSERT..ON CONFLICT), remove — **raw SQL** |
| PrismaTemplateStore | TemplateStore | list, get, save, delete (kind='infrastructure', builtIn=false) |
| PrismaPlanStore | PlanStore | load/save/delete (Setting key `plan:<projectId>`) |

DB file: `<userData>/cloudforge.db`. Backups via `VACUUM INTO`. `packages/database/.env` is
Prisma-CLI-only.

## What exists today for history/audit
- **Activity** — append-only feed, `recordSafe` used by all mutating services
- **Deployment** — run history with startedAt/finishedAt + startup crash recovery
- **VpsTarget.lastPreflight** — single snapshot, not a series

## What does NOT exist (required by a Workflow Engine)
| Need | Current state | Implication |
|---|---|---|
| Workflow definition storage | none | New model(s): `Workflow` (name, description, definition JSON graph, enabled, version?) |
| Workflow versioning | no versioning anywhere in DB | Either a `version` column + immutable copies, or a `WorkflowRevision` table |
| Execution history | only Deployment (per-deploy) | New `WorkflowExecution` (workflowId, status, trigger, startedAt/finishedAt, error) + `WorkflowExecutionStep` (nodeId, status, inputs/outputs JSON, logs pointer) |
| Execution logs | LogEntry table unused; file log only | Reuse LogEntry pattern (append-only, cascade) or per-step outputs JSON |
| Scheduling | only in-memory `setInterval` timers in container (SSL renew, CF sync) | New `WorkflowTrigger`/schedule persistence + a scheduler in main; follow existing `.unref()`'d-timer + startup-recovery patterns |
| Variables/parameters | Project.variables JSON exists (unused by any engine) | Workflow-level variables JSON is consistent with house style |
| Crash recovery | Deployment.failRunning precedent | Same pattern: mark `running` executions failed/interrupted at startup |
| Optimistic concurrency | only firewall `expectedRules` (in-memory) | Consider updatedAt-based checks for concurrent workflow edits |
| Rollback records | none (Nginx has remote backups; firewall has activity snapshots) | Per-node compensation must be modeled in the engine, not the DB |

Migration path: extend `schema.prisma` + regenerate `bootstrap.sql` (`db:bootstrap-sql`) + add
idempotent `migrateSchema()` upgrade steps — this is the established procedure (no Prisma migrate).
