# Packages

CloudForge is a **pnpm + Turborepo monorepo**. Internal packages are published as
**TypeScript source** (their `exports` point at `src/index.ts`) and bundled as
first-party code by `electron-vite` — there is no separate library build step to
keep in sync.

```
apps/
  desktop/          @cloudforge/desktop   Electron application (Presentation)
packages/
  shared/           @cloudforge/shared    Framework-agnostic kernel
  core/             @cloudforge/core      Domain + Application layers
  ui/               @cloudforge/ui        Design system (React + Tailwind)
  database/         @cloudforge/database  Prisma/SQLite adapters
  providers/        @cloudforge/providers CloudProvider adapters (Oracle)
  pulumi/           @cloudforge/pulumi    InfrastructureEngine adapter (Pulumi)
  deployment/       @cloudforge/deployment Deployer adapter (SSH)
```

**Dependency direction** (Clean Architecture): `shared` ← `core` ←
{`database`, `providers`, `pulumi`, `deployment`} ← `desktop`. `core` never
imports an adapter; adapters implement `core`'s ports.

---

## `@cloudforge/shared` — the shared kernel

Framework- and environment-agnostic primitives usable by both the Node main
process and the browser renderer. **No Node- or browser-only APIs.**

| Export                                                                                                                                                                                                                                         | Purpose                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Result<T, E>`, `ok`, `err`, `map`, `mapErr`, `andThen`, `match`, `unwrap`, `unwrapOr`, `fromThrowable`, `fromPromise`, `all`                                                                                                                  | Functional error handling used across every layer.                                                                       |
| `AppError` (+ `ValidationError`, `NotFoundError`, `ConflictError`, `ProviderError`, `InfrastructureError`, `DeploymentError`, `CredentialError`, `EncryptionError`, `PersistenceError`, `IpcError`, `UnknownError`), `ErrorCode`, `toAppError` | Serializable domain-error hierarchy. Each carries a stable `ErrorCode`, structured `context` and an IPC-safe `toJSON()`. |
| `Brand<T, B>`, `Uuid`, `newUuid`, `isUuid`, `parseUuid`                                                                                                                                                                                        | Nominal typing + Web-Crypto UUID identities.                                                                             |
| `IsoDateString`, `toIsoDateString`, `Timestamps`, `Page`, `PageRequest`, `DeepReadonly`, `Optional`, `Loadable`                                                                                                                                | Common cross-cutting types.                                                                                              |
| `APP`, `THEME_MODES`, `ThemeMode`                                                                                                                                                                                                              | Product/branding constants.                                                                                              |

Tested: `Result`, `AppError`, `Uuid`.

---

## `@cloudforge/core` — Domain + Application layers

The heart of the system. Depends **only** on `shared`. It has no knowledge of
Prisma, Electron, Pulumi, SSH or any provider SDK.

### Domain (`src/domain/`)

- `shared/entity.ts` — base `Entity<Id>` (identity equality).
- `project/` — `Project` aggregate + value objects `Environment`,
  `ProjectStatus`, branded `ProjectId`.
- `credential/` — `Credential` entity, `CredentialId`, and `CREDENTIAL_SCHEMAS`:
  the single registry of credential kinds (Oracle, AWS, Azure, GitHub,
  Cloudflare, OpenAI, Anthropic, Docker Hub, GitLab, SSH key, SSH password) and their fields.
  Drives both validation and dynamic form generation.
- `provider/provider-kind.ts` — `PROVIDER_KINDS`, `PROVIDER_LABELS`.
- `plugin/plugin.ts` — `PluginManifest`, `PLUGIN_KINDS`.

### Application — ports (`src/application/ports/`)

Interfaces implemented by adapters:

`ProjectRepository` · `CredentialRepository` · `SettingsRepository` ·
`DeploymentRepository` · `ActivityRepository` · `PluginRepository` ·
`PlanStore` · `TemplateStore` · `SecretCipher` · `ProviderFactory` ·
`ProviderCredentialResolver` · `InfrastructureEngine` · `Deployer` ·
`ContainerManager` · `AnsibleManager`.

`ProviderCredentialResolver` resolves a project's linked credential into the raw
provider fields the engine needs; `TemplateStore` persists user-saved custom
infrastructure templates.

### Application — services (`src/application/…`)

| Service                     | Responsibility                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectService`            | Project CRUD use-cases (create / list / get / update / remove / count).                                                                                                                                     |
| `CredentialService`         | Encrypt-on-write / decrypt-on-reveal credentials; metadata-only listing.                                                                                                                                    |
| `SettingsService`           | Typed `AppSettings` merged over defaults, JSON-persisted.                                                                                                                                                   |
| `ProviderConnectionService` | Decrypt a credential → build a `CloudProvider` via `ProviderFactory` → run a capability.                                                                                                                    |
| `InfrastructureService`     | Persist a plan (`PlanStore`), validate it, resolve the project's credential and run preview/apply/destroy/outputs; apply built-in templates; save/list/delete/apply **custom** templates (`TemplateStore`). |
| `DeploymentService`         | Build steps from a deployment template → run via `Deployer` → record the deployment.                                                                                                                        |
| `ActivityService`           | Record and read the audit/activity feed.                                                                                                                                                                    |
| `PluginService`             | Merge the marketplace catalog with local install/enable state.                                                                                                                                              |

### Application — templates & catalogs

- `deployment/deployment-template.ts` — `DEPLOYMENT_TEMPLATES` (Docker Host,
  Nginx, Node, Next.js, WordPress, Ollama) → ordered shell steps.
- `infrastructure/infrastructure-template.ts` — `INFRASTRUCTURE_TEMPLATES` (Web
  Server, AI Server, Database Host, Kubernetes Node) → full plans.
- `infrastructure/infrastructure-plan.ts` — the declarative plan model +
  `validatePlan`. Compute resources carry `shape`, `image`, `ocpus`, `memoryGb`,
  `bootVolumeGb`, `availabilityDomain`, `subnetName`, `sshPublicKey` and
  `assignPublicIp`.
- `plugins/plugin-catalog.ts` — `PLUGIN_CATALOG`.

Tested: `Project`, `ProjectService`, `CredentialService`, `validatePlan`,
`deployment-template`.

---

## `@cloudforge/ui` — the design system

Presentational React components styled with Tailwind. **No business logic.**

- `tailwind-preset.ts` — HSL CSS-variable design tokens driving light/dark from
  one set; consumed via Tailwind `presets`.
- `styles/globals.css` — token definitions, base layer, `.glass`, drag-region
  utilities, scrollbars.
- `lib/cn.ts` — `clsx` + `tailwind-merge` class merger.
- Components: `Button` (CVA + Radix `Slot` `asChild`), `Card`, `Input`, `Label`,
  `Textarea`, `Select`, `Badge`, `Dialog`, `DropdownMenu`, `Tabs`, `Switch`,
  `Tooltip`, `Separator`, `Skeleton`, `Table`, `Toaster`/`toast` (sonner),
  `Command`/`CommandDialog` (cmdk), `LogTerminal`.

---

## `@cloudforge/database` — persistence (Infrastructure)

Prisma client + SQLite adapters. Consumed only by the main process.

- `client.ts` — `createPrismaClient(databaseUrl)` (runtime-configurable, so no
  ambient `DATABASE_URL` is needed) + the `Db` type.
- `schema-bootstrap.ts` — `ensureSchema(db)` creates the schema in a fresh
  database from DDL **derived from `schema.prisma`** (via `prisma migrate diff`,
  inlined at build time); `migrateSchema(db)` applies idempotent in-place fixes to
  existing databases (e.g. repointing the `Project.providerId` foreign key at
  `Credential`, with a file backup). Single source of truth; see
  [Data Model](DATA-MODEL.md).
- Repositories: `PrismaProjectRepository`, `PrismaCredentialRepository`,
  `PrismaSettingsRepository`, `PrismaPlanStore`, `PrismaTemplateStore`,
  `PrismaDeploymentRepository`, `PrismaActivityRepository`, `PrismaPluginRepository`.
- `mappers/project-mapper.ts` — domain ⇄ row mapping (JSON-in-TEXT).

Runtime dep `@prisma/client` stays **external** in the bundle.

---

## `@cloudforge/providers` — cloud provider adapters

Implements `core`'s `CloudProvider` contract.

- `oracle/oci-signer.ts` — the **OCI HTTP Signature** scheme implemented with
  `node:crypto` (no heavyweight SDK). Unit-tested end-to-end (sign → verify).
- `oracle/oci-client.ts` — a signed HTTPS request helper.
- `oracle/oracle-provider.ts` — `OracleProvider`: `testConnection`,
  `getAccountInfo`, `listRegions`, `listAvailabilityDomains`, `listShapes`,
  `listInstances`, and `terminateInstance`.
- `registry.ts` — `DefaultProviderFactory` (registering a provider = one `case`
  - an implementation).

---

## `@cloudforge/pulumi` — the Infrastructure engine adapter

Implements `core`'s `InfrastructureEngine` port via the **Pulumi Automation
API**. Pulumi is fully encapsulated here; no other layer references it.

- `pulumi-engine.ts` — `PulumiEngine` (inline programs, local file backend,
  encrypted stack secrets): `isAvailable`, `preview`, `apply`, `refresh`,
  `destroy`, `outputs`, managed-stack discovery, and a streamed event sink.
  Pulumi text output is accompanied by provider-independent structured progress
  translated from resource start/output/failure/summary events. `preview`/`apply`
  receive the provider credentials and pass them to the program.
- `build-program.ts` — `buildProgram(plan, credentials?)` dispatches on
  `providerKind`; without credentials it falls back to a metadata-only program
  (offline validation / unit tests).
- `oci-program.ts` — `buildOracleProgram(plan, creds)` translates the plan into
  **real Oracle Cloud resources** via the Pulumi OCI provider: VCN + internet
  gateway + route table per network, security lists from firewall rules, subnets,
  compute Instances (live image lookup, flex-shape OCPU/RAM), and block Volumes.

Runtime deps `@pulumi/pulumi` and `@pulumi/oci` stay **external**; the Pulumi
**CLI** is a runtime prerequisite, and the OCI resource plugin is downloaded
automatically on the first preview/apply.

---

## `@cloudforge/deployment` — the deployment engine adapter

Implements `core`'s deployment, SSH-key, container and Ansible ports.

- `ssh-deployer.ts` — verified host fingerprint, cancellation/timeouts, streamed
  output and strict exit-status handling.
- `node-ssh-key-generator.ts` — Ed25519/RSA generation, encrypted PKCS#8 import
  and OpenSSH SHA-256 fingerprints.
- `ssh-container-manager.ts` — Docker lifecycle, logs/stats and Compose over
  verified SSH transport.
- `ssh-ansible-manager.ts` — remote runtime bootstrap, temporary playbook jobs,
  live output/cancellation, dependencies, and transactional Nginx configuration.
- `ansible-playbooks.ts` — generic Docker, Dockhand, Portainer, Jenkins and Nginx
  catalog with variable metadata and no project-specific values.
- `jenkins-http-manager.ts` — crumb-protected Jenkins folder/job/credential,
  trigger, status, and deletion operations. It accepts resolved secrets only at
  the adapter boundary and never persists them.
- `ssh-terminal-manager.ts` — interactive PTY sessions over the same verified
  SSH target contract used by the other VPS modules.

Runtime dep `ssh2` stays **external** (optional native binding).

---

## `@cloudforge/desktop` — the Electron application (Presentation)

Three processes plus a shared app-internal folder:

- `src/main/` — app lifecycle, hardened `BrowserWindow`, the **composition root**
  (`container.ts`), the IPC handler registry and per-feature handlers, the
  `SecretCipher` factory (`security/`), the Pulumi engine factory (`infra/`), and
  the **Pino application logger** (`logging/logger.ts`) that writes everything to
  `userData/logs/cloudforge.log` (lifecycle, every IPC call — never payloads or
  secrets — streamed engine output, crashes and forwarded renderer errors).
- `src/preload/` — the single `contextBridge` surface (`window.cloudforge`) with
  typed `invoke` + `subscribe`.
- `src/shared/ipc/` — the typed **IPC contract** (the app's source of truth for
  channels), shared by all three processes.
- `src/renderer/` — the React app: `app/` (router, providers, layout, theme,
  command palette) and `features/` (one folder per module).

See [Architecture](ARCHITECTURE.md) and [Modules](MODULES.md) for detail.

## `@cloudforge/service-providers`

Infrastructure adapters for external non-provisioning services. The Cloudflare
adapter authenticates with an encrypted API token resolved in the Electron main
process and implements the `CloudflareProvider` Application port. This package
does not depend on Pulumi or the Oracle/AWS provider package.
