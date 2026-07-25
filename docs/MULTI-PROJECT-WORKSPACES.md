# Multi-project workspace architecture

## Status

Implemented on `main`. This document records both the original audit and the
resulting workspace architecture. The release-candidate verification and known
security boundaries are recorded in
[MULTI-PROJECT-PRODUCTION-AUDIT.md](MULTI-PROJECT-PRODUCTION-AUDIT.md).

The migration is local and deliberately non-mutating: upgrading does not change
a VPS, cloud resource, DNS record, Jenkins job, Nginx configuration,
certificate, firewall, or runtime plan.

Implemented outcomes:

- startup is gated by onboarding or the locked project picker;
- a main-process `ProjectContext` owns the active session and generation;
- normal IPC is denied while locked and serialized against lock/switch/delete;
- repositories and stores derive ownership from the context and filter every
  query automatically;
- credentials, targets, pipelines, plans, templates, settings, plugins,
  activities, logs, SSH keys and secrets are project-owned;
- background automation, streams, terminal sessions and transient SSH material
  are stopped or removed during teardown;
- backups are project-bound and cannot be restored into another project;
- legacy databases are migrated transactionally and idempotently without
  touching remote systems.

## Audit: how CloudForge works before this migration

The existing `Project` aggregate represents one infrastructure definition. It
stores a name, environment, region, provider credential reference, tags,
variables, and notes. Infrastructure plans use keys containing a project id and
deployments already carry a required `projectId`.

That is not a security or isolation boundary. Most other data is global:

| Area                             | State before the migration                                                                      | Isolation problem                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Credentials and secrets          | `Credential` has no project owner. `Secret` uses an old string `scope`.                         | Any feature can resolve any credential id.                                                              |
| Providers                        | Provider records and provider clients are process-global.                                       | A project can accidentally use another project's account.                                               |
| SSH keys                         | `projectId` is nullable and deletion sets it to null.                                           | Keys can become global orphan records.                                                                  |
| VPS targets                      | Only provisioned targets have `managedProjectId`; manually added targets are global.            | Ansible, Nginx, SSL, runtime, containers, terminal, and Jenkins can select targets from other projects. |
| Runtime plans                    | Persisted by target id in the global settings table.                                            | The target id is the only effective boundary.                                                           |
| Jenkins                          | Pipelines have no project owner and folder/name is globally unique.                             | Jobs, Git credentials, environment credentials, and domains can cross projects.                         |
| Nginx, SSL, containers, firewall | Remote state is reached through a globally resolvable VPS target.                               | A caller-provided target id crosses the intended boundary.                                              |
| Cloudflare                       | Credentials, cached snapshots, defaults, and background sync are global.                        | Zones and DNS from different workspaces are mixed.                                                      |
| Templates                        | All templates are global.                                                                       | Custom templates cannot be private to one workspace.                                                    |
| Settings and plugins             | One global key/value namespace.                                                                 | Provider defaults, SSL renewal, Cloudflare, deployment, and security preferences leak between projects. |
| Activity and logs                | Project ownership is nullable or absent.                                                        | History can mix projects and survive as unowned data.                                                   |
| IPC                              | Handlers trust request payload ids; there is no active project session.                         | A compromised or stale renderer can request another project's record directly.                          |
| Process lifecycle                | Managers, timers, caches, terminal sessions, and background sync live for the full app process. | Switching a UI selection does not unload the previous project.                                          |
| Renderer                         | Each page independently selects or passes a project.                                            | Pages can disagree about the current project.                                                           |

The composition root creates one long-lived service graph. Credential
resolution often starts from an explicitly supplied project id, while most
remote services start from a globally supplied target or credential id.
`registerHandler` currently provides typed result envelopes and logging but no
project authorization.

## Target model

### Project is the workspace aggregate

A Project is the primary local tenancy boundary. It continues to own its
infrastructure configuration, and additionally owns every provider, credential,
target, runtime object, automation, deployment, cache, setting, and audit
record.

Project metadata:

- id
- name
- optional description
- optional icon
- optional color
- environment and region (retained for compatibility)
- passkey hash and passkey salt
- created date
- updated date
- last-opened date

An unlocked project is session state, never a database boolean. Closing,
locking, or switching invalidates the session.

### Project context

Project ownership is not implemented by asking every renderer component to pass
`projectId`. A main-process `ProjectContext` owns the active project session.

It exposes:

- the active project id;
- an opaque session id and monotonically increasing generation;
- `requireActiveProject()` for scoped application operations;
- `runInProject()` for an IPC invocation;
- lock/switch lifecycle hooks;
- checks that an operation still belongs to the current generation.

Repositories receive the context and add the project predicate automatically.
Application services continue to use their existing ports. A repository lookup
by id therefore means “this id in the active project”, not “this id anywhere in
the database”.

The project administration repository is intentionally unscoped. It is only
used by onboarding, picker, unlock, and project administration services.

### Session lifecycle

Opening a project:

1. Load project metadata through the unscoped project administration service.
2. Verify its passkey with the stored salt and password hash.
3. Mint a new in-memory session id and generation.
4. Build or activate project-scoped runtime resources.
5. Start only that project's background work.
6. Notify the renderer that the workspace is ready.

Locking or switching:

1. Block new scoped IPC calls.
2. Invalidate the old generation.
3. Cancel project operations and background tasks.
4. Close SSH and terminal sessions.
5. dispose provider clients, remote sessions, file watchers, and project caches.
6. Erase decrypted project secret material from in-memory caches.
7. Clear renderer query caches.
8. Activate the new project only after teardown completes.

Long-running work captures a session lease. Completion from an invalidated
generation may be logged but must not update the newly active project.

## Security model

The passkey is a local access gate, not a remote authentication system.

- A random per-project salt is generated.
- The passkey is processed by Node's memory-hard `scrypt`.
- Only the derived hash, salt, algorithm version, and parameters are stored.
- Comparisons use `timingSafeEqual`.
- Passkeys are never logged, returned by IPC, or stored in renderer state.
- Unlocking one project creates a session for only that project.
- Secrets remain encrypted with the existing OS-keychain-backed cipher.
- Project deletion, passkey changes, and destructive duplication actions use
  explicit confirmation.

The OS user who can access the CloudForge profile still controls the encrypted
database and OS keychain. A project passkey prevents accidental and casual
cross-project access; it is not a substitute for operating-system account
security or full-disk encryption.

## Database changes

Every persistent workspace record receives required project ownership and a
foreign key with `ON DELETE CASCADE`, unless a record is truly application-wide.
The only application-wide persistent data is device-level UI and lifecycle
configuration needed before a project is opened: updater preferences,
appearance, diagnostics and log-retention controls. It is stored in
`SystemSetting`. Runtime and feature settings use project-owned `Setting`.
Workspace plugins, caches, logs, and history remain project-owned.

Required ownership is added to:

- `Provider`
- `Credential`
- `VpsTarget`
- `JenkinsPipeline`
- `Template`
- `Deployment` (already required)
- `LogEntry`
- `SshKey`
- `Secret`
- `Setting`
- `Plugin`
- `Activity`

Logical uniqueness changes from global to project-local. Examples include
Jenkins folder/name, secret name, managed VPS resource name, and settings key.

The legacy `VpsTarget.managedProjectId` continues to identify the infrastructure
resource that produced a target during compatibility migration. It is not the
authorization boundary; the new required owner is.

No remote resource is modified by this database migration.

## Legacy migration

Migration runs transactionally before normal services or background timers
start.

### Empty fresh installation

If there are no projects and no legacy workspace records, no default project is
invented. Startup shows onboarding and requires the user to create a project.

### Existing installation

If legacy records exist:

1. Preserve all existing `Project` rows and ids.
2. If none exists, create one `Default Project`.
3. Preserve ownership already expressed by deployment, activity, SSH key, or
   managed-target relationships.
4. Infer target ownership from `managedProjectId`.
5. Infer Jenkins ownership from its target.
6. Infer referenced credential ownership from the project or target that uses
   it.
7. Where one formerly global record is legitimately shared by multiple
   projects, clone its encrypted/persisted record and rewrite references so each
   project receives an independent copy.
8. Copy formerly global settings, plugins, and reusable custom templates to
   each existing project when that best preserves previous behavior.
9. Put records with no inferable relationship in the deterministic default
   legacy project.
10. Validate that every scoped table has no null or dangling owner before
    enforcing required constraints.

Legacy projects initially have no passkey, so they can be opened once without a
password and are prompted to set one. This preserves unattended upgrades
without manufacturing or displaying a secret passkey.

The migration is idempotent, records its version, and creates a database backup
before table rebuilds. Failure leaves the pre-migration database usable.

## Repository and application changes

All scoped repository methods automatically filter, insert, update, and delete
using the current project. An id from another project is returned as “not
found”; existence is not disclosed.

Services keep their current responsibilities:

- infrastructure continues to use `InfrastructureService`;
- runtime continues to use `RuntimePlanService`;
- Jenkins, Nginx, SSL, Cloudflare, firewall, Ansible, containers, terminal, and
  deployment keep their existing application services;
- provider-specific behavior stays in provider adapters.

The migration changes their dependencies, not their architecture. Remote target
resolution and credential resolution become project-scoped choke points.

Operations that genuinely administer projects use a separate
`ProjectAdministrationService`; they cannot be called through a normal scoped
repository.

## IPC changes

IPC channels are divided into two groups.

Session-neutral channels:

- application information and updater;
- list project picker summaries;
- create the first/new project;
- unlock project;
- report current session;
- lock/switch project.

Every other channel requires an active project. `registerHandler` establishes
the project invocation context before executing the handler.

During compatibility, request DTOs may retain an optional deprecated
`projectId`. If present, it must equal the active project or the request fails.
New renderer code does not send project ids for normal feature operations.

The renderer never receives:

- passkey hashes or salts;
- credential ciphertext or plaintext;
- decrypted settings;
- internal session secret material.

## Renderer changes

Routing has two shells:

- a session-neutral onboarding/project-picker shell;
- the existing application shell, guarded by an unlocked project session.

If no projects exist, only onboarding, create-project, documentation, update,
and about flows are available.

The project picker shows the requested metadata and a project-scoped
infrastructure summary. Unlock occurs through typed IPC. The active project is
always visible in the top bar.

The project menu supports:

- switch;
- lock;
- settings;
- rename;
- icon/color changes;
- passkey change;
- duplicate;
- delete.

Individual feature pages remove their project selectors. React Query keys are
rooted in the project session id. Locking or switching cancels active queries
and clears the complete query cache before mounting the next workspace.

## Runtime and background behavior

Runtime plans remain the authoritative VPS topology, now additionally protected
by project ownership.

The following are project lifecycle resources:

- provider client cache;
- Pulumi/Terraform workspace handles and state paths;
- SSH connection pool and terminal sessions;
- Ansible temporary inventories and streams;
- runtime inspectors and previews;
- Jenkins and Cloudflare managers;
- SSL renewal scheduler;
- Cloudflare sync scheduler;
- file watchers;
- deployment streams;
- cached remote snapshots.

Background work starts only after unlock and stops before switch. State paths
include project id and are validated before use to prevent path traversal or
cross-project stack selection.

## Deletion and duplication

Deleting a project is not equivalent to destroying infrastructure.

The UI must state which remote resources remain. Project deletion requires the
project name and passkey, cancels active work, removes local project data in one
transaction, and does not silently destroy cloud or VPS resources.

Duplication creates a configuration-only project with new ids. It copies:

- project metadata;
- project settings, except runtime plans;
- the declarative infrastructure plan;
- providers, encrypted credentials, SSH keys and secrets;
- templates and plugin configuration.

It intentionally does not copy VPS targets, runtime plans, Jenkins pipelines,
deployments, activities, logs, remote infrastructure, terminal sessions,
cached remote state, or ownership markers claiming remote resources. The
source must already be unlocked and the duplicate receives its own required
passkey.

## Implementation phases and release gates

### Phase 1 — context, access, and migration foundation

- extend the Project aggregate and persistence;
- implement passkey hashing and project access service;
- implement session/context with generation leases;
- implement idempotent legacy ownership migration;
- expose session-neutral typed IPC;
- add unit and migration tests.

Gate: existing database fixtures migrate without row loss and a fresh database
still has zero projects.

### Phase 2 — persistence isolation

- scope every repository and store through Project Context;
- add cross-project access tests for reads, writes, updates, and deletes;
- make ownership required after successful migration.

Gate: using an id belonging to project B while project A is active always
returns not found and never mutates B.

### Phase 3 — service and runtime lifecycle

- scope all resolvers and application services;
- split global and project settings;
- stop/restart background work on session change;
- close terminals, streams, provider clients, and watchers on switch.

Gate: switch stress tests show no old-generation completion or event in the new
project.

### Phase 4 — IPC enforcement

- classify every channel;
- require an active context by default;
- validate deprecated project ids against the active context;
- test every registered channel's classification.

Gate: no feature IPC can run while locked or address a different project.

### Phase 5 — onboarding and workspace UI

- onboarding and picker;
- unlock/lock/switch;
- top-bar active project;
- project settings, passkey change, duplicate, and delete;
- remove page-level selectors;
- project-rooted query cache.

Gate: end-to-end UI tests create two projects and prove isolated resources
across repeated switches.

### Phase 6 — production validation

- upgrade fixtures from supported historical schemas;
- package/runtime verification;
- format, lint, typecheck, unit and integration tests;
- manual remote non-mutation checklist;
- documentation and release notes.

Gate: the application starts locked, legacy data is present in exactly one
appropriate project, and opening/switching projects causes no remote mutation.

## Non-negotiable invariants

1. Every workspace resource belongs to exactly one project.
2. Renderer-supplied ids never establish authorization.
3. A scoped repository can only see the active project.
4. No background task survives its project session.
5. Unlocking one project never unlocks another.
6. Legacy migration never changes remote systems.
7. Deleting a project never silently destroys remote infrastructure.
8. Project switching clears secrets, connections, streams, caches, and watchers.
9. A stale operation cannot publish into a newer project generation.
10. Provider-specific logic remains outside the project/session architecture.
