# Data Model

CloudForge persists to a local **SQLite** database via **Prisma**. The database
lives in the Electron `userData` directory as `cloudforge.db`. The schema is
defined in
[`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma).

## Conventions

- **IDs** are application-generated UUID v4 strings (`String @id`), not
  autoincrement — identities are created in the Domain layer.
- **JSON-in-TEXT**: SQLite has no native JSON/array column, so list/object
  values (`tags`, `variables`, `outputs`, `metadata`, plan/manifest blobs) are
  stored as `String` containing serialized JSON and (de)serialized in the
  repository/mapper layer.
- **Secrets are never stored in plaintext** — only `ciphertext` (see
  [Security](SECURITY.md)).
- **Timestamps** are `DateTime` (`createdAt @default(now())`,
  `updatedAt @updatedAt`) and surfaced as ISO-8601 strings in DTOs.

## Schema bootstrap (single source of truth)

`schema.prisma` is authoritative. The runtime DDL used to create the schema in a
fresh database is **derived** from it via `prisma migrate diff` and inlined at
build time; `ensureSchema(db)` runs it once (guarded by a check for the
`Project` table). To regenerate after a schema change:

```bash
pnpm --filter @cloudforge/database prisma:generate       # regenerate the client
pnpm --filter @cloudforge/database db:bootstrap-sql       # regenerate bootstrap.sql
```

## Tables (13)

### Project

The aggregate root — one managed infrastructure.

| Column                    | Type       | Notes                                                                           |
| ------------------------- | ---------- | ------------------------------------------------------------------------------- |
| `id`                      | String @id | UUID                                                                            |
| `name`                    | String     | 1–100 chars                                                                     |
| `description`             | String     | default `""`                                                                    |
| `environment`             | String     | `development` \| `staging` \| `production`                                      |
| `region`                  | String     | provider region                                                                 |
| `providerId`              | String?    | FK → **Credential** (SetNull) — the linked cloud-provider credential            |
| `templateId`              | String?    | originating template, if any                                                    |
| `status`                  | String     | `draft` \| `provisioning` \| `active` \| `error` \| `destroying` \| `destroyed` |
| `tags`                    | String     | JSON array                                                                      |
| `variables`               | String     | JSON object                                                                     |
| `notes`                   | String     | free text                                                                       |
| `createdAt` / `updatedAt` | DateTime   | indexed on `updatedAt`                                                          |

Relations: has many `Deployment`, `SshKey`, `Activity`; belongs to `Credential`
(the cloud-provider account used to provision it — this is what `providerId`
references).

> **`providerId` links a project to a `Credential`**, not to the `Provider`
> table. A project's provider account _is_ its stored credential (the credential
> resolver decrypts `providerId` to authenticate the engine). Databases created
> before this was corrected are migrated in place on startup by
> `migrateSchema(db)`, which rebuilds the `Project` table with the fixed foreign
> key after backing up the `.db` file.

### Provider

A connected cloud provider account (metadata; credentials are separate).
**Currently unused** — the app models a provider account as a `Credential`, so no
`Provider` rows are created. The table is retained for a future first-class
provider-connection concept.

| Column     | Type       | Notes                  |
| ---------- | ---------- | ---------------------- |
| `id`       | String @id |                        |
| `kind`     | String     | `oracle` \| `aws` \| … |
| `name`     | String     |                        |
| `status`   | String     | default `disconnected` |
| `metadata` | String     | JSON                   |

### Credential

Encrypted secret material for one external service.

| Column       | Type       | Notes                                                 |
| ------------ | ---------- | ----------------------------------------------------- |
| `id`         | String @id |                                                       |
| `providerId` | String?    | FK → Provider (SetNull)                               |
| `kind`       | String     | credential kind (`oracle`, `aws`, `github`, `ssh`, …) |
| `name`       | String     |                                                       |
| `ciphertext` | String     | **encrypted** base64 blob of the secret JSON          |
| `metadata`   | String     | JSON                                                  |

### Template

Persisted templates. Built-in templates live in code; this table stores
**user-saved custom infrastructure templates** ("Save as template"), where
`definition` holds the serialized `InfrastructurePlan` and `builtIn` is `false`
(see [`PrismaTemplateStore`](../packages/database/src/repositories/prisma-template-store.ts)).

| Column                | Type       | Notes                                 |
| --------------------- | ---------- | ------------------------------------- |
| `id`                  | String @id |                                       |
| `kind`                | String     | `infrastructure` \| `deployment`      |
| `name`, `description` | String     |                                       |
| `definition`          | String     | JSON — the saved `InfrastructurePlan` |
| `builtIn`             | Boolean    | `false` for user-saved templates      |

### Deployment

One run of a deployment template on a host.

| Column                     | Type       | Notes                                           |
| -------------------------- | ---------- | ----------------------------------------------- |
| `id`                       | String @id |                                                 |
| `projectId`                | String     | FK → Project (Cascade), indexed                 |
| `status`                   | String     | `pending` \| `running` \| `success` \| `failed` |
| `strategy`                 | String     | the deployment template id                      |
| `outputs`                  | String     | JSON (outcome / error)                          |
| `startedAt` / `finishedAt` | DateTime?  |                                                 |

Relations: has many `LogEntry`.

### LogEntry

Structured log lines (per deployment / project).

| Column         | Type       | Notes                              |
| -------------- | ---------- | ---------------------------------- |
| `id`           | String @id |                                    |
| `deploymentId` | String?    | FK → Deployment (Cascade), indexed |
| `projectId`    | String?    |                                    |
| `level`        | String     | default `info`                     |
| `source`       | String     | default `app`                      |
| `message`      | String     |                                    |
| `metadata`     | String     | JSON                               |
| `createdAt`    | DateTime   | indexed                            |

### SshKey

SSH key pairs associated with a project (private key encrypted).

| Column              | Type       | Notes                     |
| ------------------- | ---------- | ------------------------- |
| `id`                | String @id |                           |
| `projectId`         | String?    | FK → Project (SetNull)    |
| `name`, `publicKey` | String     |                           |
| `ciphertext`        | String?    | **encrypted** private key |
| `fingerprint`       | String     |                           |

> In the current UI, SSH keys are managed as an `ssh` **credential kind** in the
> Credential Manager (stored in `Credential`); this table is available for a
> dedicated SSH-key store.

### Secret

Generic encrypted key/value secrets, scoped globally or per project.

| Column       | Type       | Notes                      |
| ------------ | ---------- | -------------------------- |
| `id`         | String @id |                            |
| `scope`      | String     | `global` \| `project:<id>` |
| `name`       | String     | unique per scope           |
| `ciphertext` | String     | **encrypted**              |

Unique: `(scope, name)`.

### VpsTarget

A reusable verified SSH destination for Ansible. Authentication material stays
in the related encrypted `Credential`.

| Column                     | Type       | Notes                          |
| -------------------------- | ---------- | ------------------------------ |
| `id`                       | String @id | UUID                           |
| `name`, `host`, `username` | String     | Identity and connection fields |
| `port`                     | Int        | SSH port                       |
| `sshCredentialId`          | String?    | FK → Credential (SetNull)      |
| `hostKeySha256`            | String     | Pinned server identity         |
| `lastPreflight`            | String     | JSON readiness snapshot        |
| `lastPreflightAt`          | DateTime?  | Last real remote check         |
| `createdAt` / `updatedAt`  | DateTime   | indexed on `updatedAt`         |

### JenkinsPipeline

A CloudForge-managed Jenkins Pipeline job. Jobs are grouped into a deterministic
folder for their existing `VpsTarget`; the target and credentials are referenced,
not duplicated. Repository and deployment configuration is persisted, while API
tokens remain only in encrypted `Credential` records and Jenkins' credential store.

| Column                                       | Type            | Notes                                                |
| -------------------------------------------- | --------------- | ---------------------------------------------------- |
| `id`                                         | String @id      | Application UUID                                     |
| `folder`, `name`                             | String          | Unique Jenkins folder/job identity                   |
| `targetId`                                   | String          | Existing `VpsTarget` id, indexed                     |
| `jenkinsCredentialId`                        | String          | Encrypted Jenkins credential reference               |
| `githubCredentialId`                         | String?         | Encrypted GitHub credential reference                |
| `repositoryUrl`, `branch`, `jenkinsfilePath` | String          | SCM pipeline configuration                           |
| `pipelineScript`, `definitionMode`           | String          | Inline script or `scm` definition                    |
| `parameters`, `environment`                  | String          | Validated JSON; secret environment keys are rejected |
| `domain`, `applicationPort`                  | String/Int      | Optional Nginx/Cloudflare integration                |
| `cloudflareCredentialId`, `cloudflareZoneId` | String?         | Optional service-provider references                 |
| `configureDomain`                            | Boolean         | Enables DNS and Nginx orchestration                  |
| `lastStatus`, timestamps                     | String/DateTime | Jenkins state and audit timestamps                   |

### Setting

Simple key/value store. Backs `AppSettings` (`key = app.settings`) and per-project
infrastructure plans (`key = plan:<projectId>`).

| Column  | Type       | Notes          |
| ------- | ---------- | -------------- |
| `key`   | String @id |                |
| `value` | String     | JSON or scalar |

### Plugin

Locally-installed plugin state (marketplace catalog lives in code).

| Column                    | Type       | Notes             |
| ------------------------- | ---------- | ----------------- |
| `id`                      | String @id | catalog plugin id |
| `name`, `version`, `kind` | String     |                   |
| `enabled`                 | Boolean    |                   |
| `manifest`                | String     | JSON              |

### Activity

The audit / activity feed powering the Logs module and dashboard timeline.

| Column      | Type       | Notes                                                                  |
| ----------- | ---------- | ---------------------------------------------------------------------- |
| `id`        | String @id |                                                                        |
| `projectId` | String?    | FK → Project (SetNull)                                                 |
| `type`      | String     | e.g. `project.created`, `infrastructure.applied`, `deployment.success` |
| `message`   | String     |                                                                        |
| `metadata`  | String     | JSON                                                                   |
| `createdAt` | DateTime   | indexed                                                                |

## Where things are stored (summary)

| Data                              | Table / key                                                                |
| --------------------------------- | -------------------------------------------------------------------------- |
| Projects                          | `Project`                                                                  |
| Credentials (encrypted)           | `Credential`                                                               |
| App settings                      | `Setting` (`app.settings`)                                                 |
| Infrastructure plan (per project) | `Setting` (`plan:<projectId>`)                                             |
| Custom infrastructure templates   | `Template` (`kind = infrastructure`, `builtIn = false`)                    |
| Pulumi state                      | local file backend under `userData/pulumi/state` (not in SQLite)           |
| Deployment history                | `Deployment`                                                               |
| Activity/audit                    | `Activity`                                                                 |
| Saved Ansible VPS targets         | `VpsTarget`                                                                |
| Jenkins pipeline definitions      | `JenkinsPipeline`                                                          |
| Installed plugins                 | `Plugin`                                                                   |
| Application log file              | `userData/logs/cloudforge.log` (not in SQLite — see [Modules](MODULES.md)) |
