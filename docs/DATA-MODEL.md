# Data model

CloudForge persists local state in SQLite through Prisma. The database is
`cloudforge.db` under Electron `userData`; the authoritative schema is
[`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma).

## Workspace invariant

Project is the aggregate root and local isolation boundary. Every feature row
belongs to exactly one Project. Repository adapters obtain the active project
from the main-process Project Context and automatically apply `projectId` to
reads and writes.

An id from another project is treated as not found. Database triggers also
reject cross-project foreign references as defense in depth.

The single exception is `SystemSetting`, which contains only device preferences
needed before unlock: update behavior, appearance, diagnostics and log
retention. Runtime topology and feature settings never use it.

## Conventions

- IDs are application-generated UUID v4 strings.
- SQLite JSON/array values are serialized into TEXT by repository mappers.
- secrets and private keys are encrypted; plaintext is never persisted.
- timestamps are stored as `DateTime` and exposed as ISO-8601 DTO strings.
- project deletion uses cascade semantics plus explicit transactional cleanup
  for databases upgraded from historical schemas.

## Tables

### Project

Workspace metadata and access material:

- name, optional description, icon and color;
- environment, region, provider credential and originating template;
- status, tags, variables and notes;
- versioned passkey hash/salt (never the passkey);
- created, updated and last-opened timestamps.

The passkey is an application-level local gate. It is hashed with scrypt and is
not returned by IPC. Legacy projects may temporarily have no passkey so an
upgrade never manufactures an inaccessible password.

### Provider and Credential

Both are project-owned. `Credential.ciphertext` stores an encrypted provider or
service payload; metadata is non-secret. A Credential may refer to a Provider
in the same project. `Project.providerId` refers to the project-owned cloud
credential selected for provisioning.

### VPS target

A project-owned, host-key-pinned SSH destination:

- host, port and username;
- optional project-owned SSH credential;
- pinned SHA-256 server identity;
- last readiness/preflight snapshot;
- optional infrastructure resource identity for managed-target reconciliation.

Ansible, Nginx, SSL, runtime, containers, terminal and Jenkins all resolve the
same scoped target rather than maintaining global target lists.

### Jenkins pipeline

A project-owned Jenkins folder/job definition with:

- target and Jenkins/Git/environment/Cloudflare credential references;
- repository, branch, Jenkinsfile or inline script;
- typed parameters and non-secret environment;
- optional domain, application port and Nginx routes;
- last synchronized Jenkins status.

Uniqueness is `(projectId, folder, name)`.

### Template

Project-owned infrastructure or deployment definitions. Custom templates are
private to the workspace. Built-in definitions are materialized per project
where persistence is needed.

### Deployment and LogEntry

Deployment records are project-owned and store strategy, status, outputs and
timing. Log entries require the same project and may refer only to a deployment
inside that project. The database trigger rejects a cross-project relation.

### SSH key and Secret

Both require project ownership. SSH private material and generic secret values
are ciphertext. Secret names are unique inside a project, not globally.

### Setting and SystemSetting

`Setting` uses composite key `(projectId, key)`. It stores project settings,
infrastructure plans (`plan:<projectId>`), runtime plans
(`runtime-plan:<targetId>`) and scoped cached configuration.

`SystemSetting` uses a global key and is restricted to pre-unlock device
preferences. It must not contain credentials, topology or provider defaults.

### Plugin

Installed declarative plugin state is keyed by `(projectId, id)`. Activating a
plugin in one project does not activate it in another.

### Activity

Project-required audit events with type, message, JSON metadata and timestamp.
Activity queries never combine workspaces.

## Referential integrity beyond Prisma

The ownership migration installs SQLite insert/update triggers for:

- Project → Credential (`providerId`);
- Credential → Provider;
- VPS target → SSH Credential;
- Jenkins pipeline → target and all credentials;
- LogEntry → Deployment.

Each referenced row must have the same `projectId`. This protects legacy
databases even where an old physical foreign key cannot be changed with
`ALTER TABLE`.

## Legacy ownership migration

`migrateProjectOwnership` runs transactionally before application services:

1. keeps a fresh database at zero projects;
2. preserves existing project ids and records;
3. creates a deterministic Default Project only when unowned legacy data
   exists;
4. infers ownership from projects, deployments, managed targets and references;
5. clones formerly shared rows where separate project ownership is necessary;
6. fills and validates every required owner;
7. installs project-local uniqueness and integrity triggers;
8. records a migration version so subsequent startup is idempotent.

A database backup is made before destructive table rebuilds. No remote adapter
is involved, so migration cannot modify a VPS or cloud account.

## Storage outside SQLite

| Data                 | Location and boundary                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Pulumi state         | local backend below `userData`; stack references include the project identity             |
| Application log file | `userData/logs/cloudforge.log`; log records shown in-app are project scoped               |
| Portable backups     | project-bound format with embedded project id; cross-project restore is rejected          |
| Temporary SSH keys   | `userData/runtime-keys/<projectId>`; removed on lock, switch, shutdown and crash recovery |

See [Multi-project workspaces](MULTI-PROJECT-WORKSPACES.md) and the
[production audit](MULTI-PROJECT-PRODUCTION-AUDIT.md) for lifecycle guarantees.
