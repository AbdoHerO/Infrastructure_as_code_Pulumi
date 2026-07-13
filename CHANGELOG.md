# Changelog

All notable changes to CloudForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project builds in phases.

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
