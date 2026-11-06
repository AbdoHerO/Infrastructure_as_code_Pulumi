# Changelog

All notable changes to CloudForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project builds in phases.

## [Unreleased]

### Added

- **Keep trying** (Infrastructure): when Oracle answers `Out of host capacity`,
  CloudForge can apply the plan you previewed every 2 minutes until the server is
  created, then tell you with a notification. It stops by itself on any error that
  waiting cannot fix or if the plan changes. See `docs/FIRST-INSTANCE.md`.
- **MCP server** (Settings → MCP): an AI assistant such as Claude can now use every
  feature of CloudForge, through 234 tools, 16 resources and 13 guided workflows. It
  is off by default, only accepts connections from this computer with a token, and
  works on the project open in the window. You decide what a client may do: critical
  actions ask you in the window each time, reading secrets and running commands on
  servers stay off until you allow them, and a client cannot change these settings.
  Every change a client makes appears in the activity feed. See `docs/MCP.md`.
- The **Firewall** page now works with AWS instances, through their security groups.
- **Cloud Providers** can now list machine images for Oracle Cloud too.
- New abilities, available in the API and to MCP clients: renew due certificates now,
  remove a DNS record CloudForge created, read a saved template's plan, ready-made DNS
  records and plan resources, the SSH connections of a stack, comparing an Nginx
  backup with the live config, connection instructions for SSH access, advice on
  firewall rules and their history, running one command on a server, the state of the
  background jobs, pruning logs now, and filtering the activity feed.
- **Docker Stacks** page: deploy any Docker Compose stack on a saved server and
  publish it on one or more domains. Load the Compose file and `.env` from a
  folder or paste them; they stay as written, with a generated file adding the
  local ports. Choose a Cloudflare domain and a subdomain; a domain already used
  by another application, an Nginx site or a Cloudflare record elsewhere is
  blocked, and a missing record is created. HTTPS is handled per domain: Cloudflare
  Origin CA behind the proxy, Let's Encrypt otherwise. External networks and
  volumes are created when missing and never deleted. The files are stored
  encrypted and never placed in a script, a command line or a log.

### Changed

- The `domain` option of `deploy:run` is gone: no deployment template used it.
- Updated Electron to 43.8.3, undici to 7.30.1 and 6.29.1, and zod to 4.6.7, which
  the release audit flagged as high severity.
- WordPress now handles HTTPS the same way: an Origin certificate behind the
  Cloudflare proxy, instead of always Let's Encrypt.

### Fixed

- SSH connections now refuse a server fingerprint CloudForge did not read itself or
  have saved, on every page.
- The Nginx page no longer keeps one server's `nginx.conf`, site or logs after you
  switch to another server, so they can no longer be saved to the wrong one. Saving
  the main config now asks first, and a log export is named after what it contains.
- The SSL page clears certificates from another server, asks before exporting a zip
  (it contains the private key), says when issuing switches a whole Cloudflare zone,
  and reports when it cannot read the server's sites.
- **Copy** buttons for credentials, SSH keys and the log path now really copy. They
  said "Copied" while the window was not allowed to use the clipboard.
- Failures that showed nothing now show a message: saving settings, updates, deleting
  a credential, Cloudflare zones and records, zone settings, the firewall page,
  starting or stopping instances, and container logs and statistics.
- The Dashboard shows real numbers instead of fixed zeros.
- The Jenkins page sends exactly the values it shows, and asks before a build with a
  `WIPE` parameter, which erases data.
- The Ansible page no longer overwrites what you typed when it refreshes, connects on
  every key, checks the wrong profile after a repair, or turns an emptied number into 0. Showing the PostgreSQL login no longer needs the password typed again.
- The infrastructure editor's custom image field now appears, sizes no longer stay
  hidden in a plan after choosing a fixed shape, and declining a destructive apply no
  longer saves the plan first. A plan with no image, or a kind CloudForge cannot
  create, is now reported instead of failing or being skipped.
- The Cloudflare page can show all zones, keeps batch actions to the records you can
  see, no longer turns a template into an update of the record being edited, and
  cleans up tags. Page rules can be cancelled and redirect rules reset after saving.
- Cancelling the folder picker no longer leaves project import stuck on "Importing…".
- Pressing Enter on a project with an empty passkey no longer tries to open it.
- Settings fields show the stored value, including after it is corrected, and save only
  when changed.
- Saved servers added elsewhere now appear in SSH access and the host firewall.
- The VPS Runtime page asks before changing mode, releasing a resource or opening
  ports, and no longer re-reads the server each time the window gets focus.
- The Docker Stacks page reports a failed analysis instead of keeping the old one.
- More is recorded in the activity feed: credentials, SSH keys, servers, plugins,
  settings, backups, starting and stopping instances, stack and site redeploys,
  plan saves and previews, and templates.
- Private keys prepared for SSH are now removed when CloudForge closes, not at the next
  start, and are written only when you click **Prepare SSH command**.
- Applying an infrastructure plan with problems is now refused by the application
  itself, not only by the page, and so is applying a preview that deletes or replaces
  resources unless those changes were accepted.
- The VPS Runtime page now shows the output of an apply.
- The "Default region" setting now pre-fills the region of a new project.
- Exporting a project backup now enforces the 12-character passphrase in the
  application itself, not only on the page.
- The background Cloudflare synchronization no longer makes Lock or Switch project
  fail with "Wait for the active operation to finish".
- A proxied domain in a Flexible Cloudflare zone no longer gets a redirect to
  HTTPS on the server, which sent visitors round in an endless loop.
- Removing or deleting a WordPress site now stops renewing its certificate;
  renewal also drops certificates whose Nginx site no longer exists.
- Deleting a WordPress site deletes the DNS record CloudForge created for it.
- Duplicating a project no longer copies its WordPress site records, which let the
  copy act on sites that belong to the original.
- WordPress sites behind the Cloudflare proxy no longer show a false warning.

## [0.4.4] — 2026-10-26

### Added

- **WordPress** page: deploy a WordPress site on a saved server and domain in one
  step. The latest official images (WordPress, MariaDB LTS, WP-CLI) run as one
  Docker Compose stack per site, visible in Containers and Dockhand; CloudForge
  installs WordPress (title, admin account, HTTPS-aware site URL, 64 MB uploads),
  creates the Cloudflare DNS record (optional), publishes the domain with Nginx
  and requests a Let’s Encrypt certificate. Each site can be checked, updated
  (images and WordPress core), redeployed, removed (data kept) or deleted. The
  database and admin passwords are generated, stored as an encrypted secret and
  never placed in a script, a command line or a log. The domain is picked from
  the Cloudflare account's domains (the domain itself or a new subdomain) and
  is blocked when another site, a Jenkins pipeline, an Nginx site on the
  server or a Cloudflare record pointing elsewhere already uses it.
- SSH Keys page: **SSH access for other people**. Give a client or a colleague
  their own account on a saved server from their public key, with or without
  sudo, and get the connection instructions (command, server fingerprint and a
  message to send, in English or French). A ready-made message asks the person
  for their public key. Remove deletes the account and closes their sessions.
  Only accounts CloudForge created are ever changed; existing accounts, `root`
  and CloudForge's own login are refused; private keys are refused with a
  warning; the SSH server's configuration is only read, and blocking settings
  (`AllowUsers`, `AllowGroups`, public-key login off) are reported.

### Fixed

- Export project and Restore failed with "Foreign key constraint violated" on
  installations upgraded from the single-workspace version: deleting the other
  projects from the backup copy tripped the ownership triggers, and tables
  without a cascade could keep other projects' rows. Both now delete each
  project's rows explicitly, like project deletion already did.
- macOS: CloudForge opened from Finder or the Dock now finds a Pulumi CLI
  installed with Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) or with
  Pulumi's installer (`~/.pulumi/bin`); such apps only get the system's minimal
  PATH.

## [0.4.3] — 2026-10-08

### Security

- Electron 43.7.9 and patched transitive packages (undici, @grpc/grpc-js,
  brace-expansion, tar, js-yaml, ip-address, postcss-selector-parser,
  http-cache-semantics 4.3.0): the production audit reports no high advisory.
  http-cache-semantics' max-stale advisory has no published fix; it is reached
  only through Pulumi's private download cache, which is not shared between users.

### Note

- v0.4.2 was tagged but not published (the release audit stopped it); 0.4.3
  contains everything listed under 0.4.2.

## [0.4.2] — 2026-10-08

### Added

- Firewall page: a **VPS firewall** section under the cloud security list. It
  reads the server's own firewall (ufw, firewalld, nftables or iptables) over
  SSH for the saved target matching the instance, shows which ports each of the
  two firewalls lets through (80 and 443 marked reachable only when both do),
  and opens a single port — one click for HTTPS (443) or HTTP (80) — without an
  Nginx domain or runtime route. CloudForge's own rules can be closed again; the
  SSH port CloudForge connects through can never be closed. Every change is in
  the activity log.
- A PostgreSQL profile with Docker network management; an explicit "Remove
  passkey" action for projects.

### Fixed

- A surviving route is relinked when its application is removed; an empty stack
  is no longer reported as managed infrastructure, and a timer is not a blocker.

### Added

- Completed Phases 12–19: verified SSH host trust, cancellable/time-bounded
  deployments, dedicated SSH Keys, remote Containers/Compose, paginated OCI
  inventory and lifecycle controls, Pulumi drift refresh, backup/restore, log
  rotation, real packaged updates, cross-platform CI/release/SBOM automation and
  a safe declarative extension runtime.
- Added RSA/Ed25519 key-generator, settings and extension lifecycle regression
  tests; the suite now contains 62 passing tests across 15 files.
- Structured infrastructure progress derived from Pulumi Automation API engine
  events. Preview, Apply, Refresh and Destroy now show an indeterminate progress
  bar, the current resource operation, per-resource Ready/Failed states and an
  operation-specific completion message.
- Managed-stack discovery/destruction and direct OCI account-instance discovery
  and termination, including dependency-safe deletion guidance.
- A first-instance walkthrough and an evidence-based completion roadmap.

### Changed

- Enabled the Electron renderer sandbox and removed non-functional telemetry and
  fake provider/plugin claims. Docker installation no longer pipes a downloaded
  script into a privileged shell.
- Documentation now distinguishes implemented modules from placeholders and
  partial foundations. Removed incorrect claims that Ansible, Docker SDK based
  container management, executable plugins and real auto-updates already ship.

## [Phase 11] — Hardening, Coverage & Packaging

### Added

- **Security hardening**: the default session now denies every renderer
  permission request (camera, microphone, geolocation, …) via
  `setPermissionRequestHandler`/`setPermissionCheckHandler`, complementing the
  existing context isolation, CSP and navigation guards.
- **Coverage**: a Vitest workspace enables `pnpm test:coverage` to run all 49
  tests with a single V8 coverage report from the repo root.
- **Packaging**: `electron-builder` configuration (`electron-builder.yml`) with
  Windows/macOS/Linux targets and `asarUnpack` for the native/runtime deps
  (`@prisma/client`, `.prisma` engine, `ssh2`, `@pulumi/pulumi`); `package` /
  `package:dir` scripts. See [docs/PACKAGING.md](docs/PACKAGING.md).

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` all green;
  `pnpm test:coverage` runs 49 tests across the workspace.

## [Phase 10] — Templates, Plugins & Updates

### Added

- **Infrastructure templates** (core): a registry of predefined plans (Web
  Server, AI Server, Database Host, Kubernetes Node) that generate a full
  `InfrastructurePlan`; `InfrastructureService.applyTemplate` persists one to a
  project. **Templates** module lists both infrastructure and deployment
  templates and applies infra templates to a selected project.
- **Plugin system**: plugin manifest + kinds (provider/template/widget/theme/
  ansible-role), a marketplace `PLUGIN_CATALOG`, `PluginRepository` port +
  `PrismaPluginRepository`, and `PluginService` (merge catalog with local
  install/enable state). **Plugin Marketplace** module with install + enable
  toggles.
- **Updates** module: `updates:check` IPC and a version/status page (electron-
  updater wiring lands at packaging time).

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (43) and `pnpm build` all green.

## [Phase 9] — Logs, Activity & Charts

### Added

- **Activity/audit feed**: `ActivityService` + `ActivityRepository` port +
  `PrismaActivityRepository`. Notable events (project created/deleted,
  infrastructure applied/destroyed, deployment succeeded/failed) are recorded
  best-effort and exposed via `activity:list`.
- **Logs** module: a searchable, category-filterable, JSON-exportable activity
  feed with a reusable `ActivityTimeline` and relative timestamps.
- **Dashboard**: the Activity card now streams the real recent activity, plus a
  new "Projects by environment" bar chart (accessible, theme-aware).

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (43) and `pnpm build` all green.

## [Phase 8] — Deployment Pipeline

### Added

- **Deployment templates** (core): a registry of reproducible, provider-agnostic
  templates (Docker Host, Nginx, Node, Next.js, WordPress, Ollama) that emit
  ordered, idempotent shell steps (Docker install, UFW/fail2ban hardening, app
  launch). Pure step builders, unit-tested.
- **`Deployer` port** + **`DeploymentService`** coordinating: build steps →
  execute on the host → record the deployment. `DeploymentRepository` port +
  `PrismaDeploymentRepository`. SSH private keys now live in the Credential
  Manager via a new `ssh` credential kind.
- **`@cloudforge/deployment`** — `SshDeployer` (via `ssh2`) runs steps
  sequentially over SSH, streaming stdout/stderr per step and stopping on the
  first failure.
- **Deployments** module: pick a project, template, host and SSH key; run with a
  live streamed log terminal (`deploy:log` events); deployment history table.

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (43) and `pnpm build` all green;
  `ssh2` stays external in the main bundle.

## [Phase 7] — Infrastructure Module

### Added

- **Typed IPC event streaming** (main → renderer): an allow-listed event channel
  in the contract, a `subscribe` method on the secure bridge, and an `emitEvent`
  broadcaster — used to stream live engine output (and reused by later phases).
- **`InfrastructureService`** (core) coordinating a project's plan: persistence
  via a new `PlanStore` port (`PrismaPlanStore`, keyed per project), validation,
  and preview / apply / destroy / outputs against the engine with a streamed
  event sink. Infra IPC channels + handlers derive a stable stack reference per
  project.
- Renderer **Infrastructure** module: project selector, a schema-driven plan
  editor (add/remove/edit networks, subnets, firewalls, compute, volumes),
  client-side plan validation, and **Preview / Apply / Destroy** actions with a
  live terminal-style log viewer (new reusable `LogTerminal` component).

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (41) and `pnpm build` all green.

## [Phase 6] — Pulumi Infrastructure Engine

### Added

- **`InfrastructureEngine` port** in `@cloudforge/core` (preview / apply / refresh
  / destroy / outputs / availability, with a streamed event sink) and a
  provider-agnostic, declarative **`InfrastructurePlan`** model (network, subnet,
  firewall, compute, volume, …) with a pure, unit-tested `validatePlan`.
- **`@cloudforge/pulumi`** — the engine implementation using the **Pulumi
  Automation API** (inline programs, local file backend, encrypted stack
  secrets). Pulumi is fully encapsulated here; no other layer references it. A
  `buildProgram` interpreter turns a plan into a Pulumi program (unit-tested;
  extended to real cloud resources in Phase 7).
- Engine wired into the composition root (private Pulumi home + local backend +
  persisted passphrase under `userData`), an `infra:engineStatus` IPC channel,
  and a live "IaC engine" status row on the dashboard.

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (41) and `pnpm build` all green;
  `@pulumi/pulumi` stays external in the main bundle while the engine is bundled.

## [Phase 5] — Cloud Providers & Oracle Cloud

### Added

- **Provider contract** in `@cloudforge/core`: the provider-independent
  `CloudProvider` interface (test connection, account info, list
  regions/shapes/availability-domains), provider kinds + labels, a
  `ProviderFactory` port, and the `ProviderConnectionService` that decrypts a
  stored credential and runs a capability against the right provider.
- **`@cloudforge/providers`** — the plugin package:
  - Oracle Cloud provider implemented against the OCI REST APIs using the OCI
    request-signing scheme (`node:crypto`), no heavyweight SDK. Signing logic is
    unit-tested end-to-end (sign → verify with a generated keypair).
  - `DefaultProviderFactory` — registering a provider is one `case` + an
    implementation of the interface.
- **Provider IPC** channels/handlers and the renderer **Cloud Providers** module:
  per-credential connection testing with account info, and on-demand region/shape
  discovery.

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (38) and `pnpm build` all green.

## [Phase 4] — Credential Manager & Settings

### Added

- **Credential Manager** — encrypted storage for provider/service secrets:
  - Schema-driven credential kinds (Oracle, AWS, Azure, GitHub, Cloudflare,
    OpenAI, Anthropic, Docker Hub, GitLab) — one declarative registry drives both
    validation and dynamic form generation.
  - `Credential` domain entity + `CredentialService` that encrypts secret
    material through a `SecretCipher` port before persistence and decrypts only
    on explicit reveal or internal provider use; list returns metadata-only
    summaries (never secrets).
  - Main-process `SecretCipher`: OS keychain via Electron `safeStorage` when
    available, AES-256-GCM with a `0600` local key as fallback — never plaintext.
  - `PrismaCredentialRepository`; credential IPC channels + handlers.
  - Renderer **Secrets** module: security banner, credential table, schema-driven
    add dialog, masked reveal-with-copy dialog, delete.
- **Settings** — `SettingsService` (typed settings merged over defaults, stored
  as JSON), `PrismaSettingsRepository`, IPC channels, and a tabbed **Settings**
  page (General, Appearance, Deployment, Security) wired to live persistence and
  the theme store.

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (35) and `pnpm build` all green.

## [Phase 3] — Design System & Command Palette

### Added

- **Design-system components** in `@cloudforge/ui`, built on Radix and styled to
  the token set: `Dialog`, `DropdownMenu`, `Tabs`, `Switch`, `Tooltip`,
  `Separator`, `Skeleton`, `Table`, a `sonner`-based `Toaster` + `toast`, and a
  `cmdk`-based `Command`/`CommandDialog`. `Button` now supports `asChild`.
- **Command palette** (⌘K / Ctrl+K): fuzzy-search and jump to any module, wired
  to a global keyboard-shortcut hook and the titlebar search field.
- App-wide `TooltipProvider` and `Toaster`; toast feedback on project
  create/delete.

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (30) and `pnpm build` all green.

## [Phase 2] — Domain Model & Persistence

### Added

- **`@cloudforge/core`** — the Domain and Application layers:
  - `Project` aggregate root with value objects (`Environment`, `ProjectStatus`),
    validating factory/update methods returning `Result`, and a base `Entity`.
  - `ProjectRepository` port and the `ProjectService` use-cases
    (create/list/get/update/remove/count) returning DTOs and typed errors.
  - 12 unit tests (domain invariants + service behaviour with an in-memory repo).
- **`@cloudforge/database`** — the persistence Infrastructure layer:
  - Full Prisma schema on SQLite for all 11 tables (Project, Provider,
    Credential, Template, Deployment, LogEntry, SshKey, Secret, Setting, Plugin,
    Activity).
  - Runtime-configurable Prisma client factory and a `schema.prisma`-derived
    bootstrap that creates the schema in a fresh database.
  - `PrismaProjectRepository` and domain⇄row mappers.
- **Desktop wiring** — a main-process composition root (`container.ts`) that
  initialises the database and services; project IPC channels + handlers; and a
  real **Projects** module in the renderer (list, create via React Hook Form +
  Zod, delete) driven end-to-end through the typed IPC contract. The Dashboard
  now shows the live project count.
- Design-system additions: `Input`, `Label`, `Textarea`, `Select`, `Badge`.

### Fixed

- Workspace packages are now **bundled** into the Electron main/preload output
  (they ship as TypeScript source and cannot be `require`d at runtime);
  `@prisma/client` remains external.

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (30 passing) and `pnpm build`
  (with all 11 tables' DDL inlined into the main bundle) all green.

## [Phase 1] — Foundation & Running Shell

### Added

- **Monorepo foundation**: pnpm workspaces, Turborepo, a single strict
  `tsconfig.base.json`, ESLint 9 (flat, type-checked) + Prettier, Vitest, and
  shared editor/tooling configuration.
- **`@cloudforge/shared`** — the framework-agnostic shared kernel:
  - `Result<T, E>` functional error handling with the full combinator set.
  - `AppError` hierarchy with stable error codes, structured context and
    IPC-safe `toJSON()` serialization.
  - Branded types (`Brand`), UUID identities, common types (`Page`, `Loadable`,
    `Timestamps`, …) and product constants.
  - 18 unit tests.
- **`@cloudforge/ui`** — the design-system base: a Tailwind preset with HSL
  CSS-variable tokens (light/dark), the `cn` utility, global stylesheet, and the
  first `Button` and `Card` components.
- **`@cloudforge/desktop`** — the Electron application (via `electron-vite`):
  - Hardened main process: context isolation on, Node integration off, strict CSP,
    external-navigation guarding and secure window defaults.
  - Typed, secure IPC contract with a `Result`-envelope registry and a single
    `contextBridge` surface (`window.cloudforge`).
  - React renderer: TanStack Query, Zustand theme store (light/dark/system),
    React Router, a resizable app shell (sidebar + draggable titlebar), and a live
    Dashboard reading real runtime info over IPC.
  - All fourteen modules wired into navigation and routing (placeholders name the
    phase in which each lands).

### Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (18 passing) and `pnpm build`
  (main + preload + renderer) all green.
