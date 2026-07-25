# Multi-project production-readiness audit

## Release-candidate result

CloudForge now treats a Project as the local workspace and authorization
boundary. The migration extends the existing Domain → Application → Ports →
Adapters → typed IPC → Renderer architecture; it does not introduce a parallel
service graph or move business rules into React.

This audit covers the implementation introduced by commits `cb98c96` through
`641cde8`. The authoritative design and legacy-state analysis are in
[MULTI-PROJECT-WORKSPACES.md](MULTI-PROJECT-WORKSPACES.md).

## Boundary map

| Boundary        | Production behavior                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Session         | `ProjectSessionService` verifies a scrypt passkey and activates one in-memory session id/generation.                                 |
| IPC             | All channels require the active project by default. Only onboarding, picker, app lifecycle and updater channels are session-neutral. |
| Concurrency     | Scoped IPC holds a project operation lease. Lock, switch and delete wait for active operations and are serialized.                   |
| Persistence     | Scoped repositories derive the owner from `ProjectContext`; ids from another project resolve as not found.                           |
| Database        | Required `projectId` columns, project-local uniqueness and SQLite triggers prevent cross-project references.                         |
| Secrets         | Ciphertext remains OS-keychain protected and project-owned. Tokens and passkey hashes never enter picker DTOs.                       |
| Remote access   | VPS targets and credentials resolve only inside the active project. SSH connections and terminals close on teardown.                 |
| Runtime         | Infrastructure plans, runtime plans, Pulumi stack references, previews and streams are project scoped.                               |
| Background work | SSL renewal and Cloudflare synchronization start after activation and stop before deactivation.                                      |
| Files           | Backup archives and transient SSH material include the project id and are rejected across project boundaries.                        |
| Renderer        | Feature routes do not mount while locked; the query cache is cleared before another workspace renders.                               |

## Persistent ownership

The following models have required project ownership:

- Provider
- Credential
- VPS target
- Jenkins pipeline
- Template
- Deployment and deployment log
- SSH key
- Secret
- Setting
- Plugin
- Activity

Runtime and infrastructure plans are persisted as project-scoped settings.
Nginx, SSL, Cloudflare, firewall, Ansible, containers and SSH terminal state are
reached through a project-owned VPS target and credential rather than through
global records.

`SystemSetting` is the deliberate exception. It contains device preferences
needed while no project is open: updates, appearance, diagnostics and log
retention. It must never contain topology, provider credentials or feature
state.

## Project lifecycle

### Create and unlock

Desktop project creation requires a passkey of at least eight characters in the
main process. `NodeProjectPasskeyHasher` uses scrypt with a random salt and a
versioned digest. Legacy projects can have no passkey so upgrades are not
locked behind a manufactured password; after opening one, the user can set a
passkey in Project Settings.

The locked picker receives only safe metadata and aggregate counts. It does not
receive project variables, notes, credential ids, secret values, passkey
digests or resource records.

### Lock and switch

Teardown:

1. stops accepting new project work;
2. waits for or cancels registered operations;
3. stops SSL and Cloudflare background tasks;
4. closes SSH terminals and key material;
5. clears active runtime/session state;
6. clears renderer queries;
7. activates the replacement only after teardown completes.

Each operation captures the session generation, preventing a late completion
from publishing into a later project.

### Delete

Deletion does not destroy remote resources. The application refuses deletion
while a managed Pulumi stack remains. Authorization is enforced in the main
process and requires:

- an active session for the same project;
- the exact project name;
- the project passkey when the project is protected.

After safety checks, the session is closed and local project data is removed in
one transaction. Explicit table cleanup also supports older SQLite databases
whose columns were added before physical cascade constraints existed.

### Duplicate

Duplication is configuration-only. It copies metadata, the infrastructure plan,
providers, credentials, SSH keys, secrets, templates, project settings and
plugin configuration with remapped ids. It excludes runtime plans, targets,
pipelines, deployment/history rows, logs and all claims on existing remote
resources.

## Legacy migration

The ownership migration runs before services and schedulers start:

- a truly empty database remains empty and opens onboarding;
- existing project ids and rows are preserved;
- a deterministic default project is created only for legacy workspace data
  that has no project;
- ownership is inferred from existing project, deployment, target and
  credential relationships;
- formerly shared data is cloned where isolation requires independent rows;
- the migration version makes repeated startup idempotent;
- a pre-rebuild database backup protects recovery;
- no provider, SSH, Pulumi, Cloudflare, Jenkins or Nginx adapter is called.

Migration tests execute actual legacy SQLite schemas, not only mocked rows, and
assert preservation, empty-install behavior and idempotency.

## Cross-project protections

Application filtering is backed by database integrity triggers for references
that SQLite/legacy foreign keys cannot express:

- Project → provider credential
- Credential → Provider
- VPS target → SSH credential
- Jenkins pipeline → target and all credential references
- Log entry → Deployment

An insert or update attempting to connect rows from different projects aborts.
This is defense in depth; normal repositories reject the request earlier.

## Backups and transient material

Backup format version 3 records the project id. Restore validates that id before
writing and refuses cross-project archives. Temporary exported SSH keys are
created under a project-specific runtime directory with owner-only permissions.
They are removed on lock, switch, shutdown and next-start crash recovery.

## Security scope

A project passkey is a local workspace gate. It protects against accidental or
casual cross-project access inside CloudForge, but it does not replace OS
account security or disk encryption. The OS user still controls the application
profile and keychain. Each project has an independent passkey digest while
secret ciphertext continues to use the established OS-keychain-backed cipher.

## Validation evidence

Automated release gates:

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
```

Targeted suites cover passkey verification, session serialization, repository
isolation, cross-project database triggers, legacy SQLite migration, backup
boundaries, background task teardown and transient key cleanup.

Manual packaged-app smoke checks remain appropriate before publishing:

1. launch with a fresh profile and create the first project;
2. create two protected projects with different credentials and targets;
3. switch repeatedly while a long-running read is active;
4. verify no target, terminal, log or query from the first project appears;
5. restart and verify the picker starts locked;
6. upgrade a copy of a pre-workspace database and compare row counts;
7. duplicate a project and verify it has configuration but no remote ownership;
8. attempt deletion with the wrong name/passkey and with a managed stack;
9. destroy the test stack, delete the project and confirm the other project is
   unchanged.

These smoke checks may use disposable resources. The database migration itself
must never be tested by mutating a production VPS.
