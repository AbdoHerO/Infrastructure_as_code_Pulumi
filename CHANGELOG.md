# Changelog

All notable changes to CloudForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project builds in phases.

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
