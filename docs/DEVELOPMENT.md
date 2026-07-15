# Development Guide

## Prerequisites

- **Node.js ≥ 20.18** and **pnpm ≥ 9**
- For runtime features: the **Pulumi CLI** (Infrastructure) and **SSH access** to
  a host (Deployments). See [Packaging](PACKAGING.md#runtime-prerequisites-end-user-machine).

## Setup

```bash
pnpm install                                          # install the workspace
pnpm --filter @cloudforge/database prisma:generate    # generate the Prisma client
pnpm desktop                                          # run the app in dev (HMR)
```

## Workspace scripts

Run from the repo root:

| Command              | Description                                               |
| -------------------- | --------------------------------------------------------- |
| `pnpm desktop`       | Run the Electron app in development (electron-vite HMR).  |
| `pnpm build`         | Build every package and the desktop app (Turborepo).      |
| `pnpm typecheck`     | Type-check the whole workspace.                           |
| `pnpm lint`          | Lint the whole workspace (ESLint 9, type-checked).        |
| `pnpm test`          | Run all unit tests (per package, via Turborepo).          |
| `pnpm test:coverage` | Run all tests from root with a single V8 coverage report. |
| `pnpm format`        | Format the codebase with Prettier.                        |

Per-package: `pnpm --filter @cloudforge/<pkg> <script>` (each package exposes
`typecheck`, `lint`, `test`, `build`).

## Quality gates

Nothing is merged unless **all four are green**: `typecheck`, `lint`, `test`,
`build`. The build additionally verifies bundling correctness (workspace packages
bundled into main; `@prisma/client`, `ssh2`, `@pulumi/pulumi` kept external).

## Coding conventions

- **TypeScript strict** — the base config enables `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUnusedLocals/Parameters`.
  - `exactOptionalPropertyTypes` means an optional prop that may receive
    `undefined` must be typed `x?: T | undefined`, or the value omitted.
  - Prefer `import type { … }`; use inline `type` qualifiers.
  - In renderer ESM modules, use the global `JSX.Element` (not `React.JSX.Element`,
    which is a UMD-global error) and import React types explicitly
    (`import type { ReactNode } from 'react'`).
- **Errors** — expected failures return `Result<T, E>` (from `@cloudforge/shared`),
  never thrown. Exceptions are reserved for truly unrecoverable conditions.
- **No business logic in React** — components render state and dispatch intent;
  rules live in `@cloudforge/core`.
- **Provider independence** — nothing provider-specific may appear in the UI or
  Application layer; it lives behind the `CloudProvider` contract.
- **Naming** — files `kebab-case.ts`; React components `PascalCase.tsx`; one
  public entry (`src/index.ts`) per package.
- **Formatting** — Prettier (100 cols, single quotes, trailing commas), enforced
  by `eslint-config-prettier` + the Tailwind class-sorting plugin.

## How the monorepo builds

Internal packages are consumed as **TypeScript source**. `electron-vite` bundles
them into the main/preload/renderer outputs, and the Vite config keeps native /
runtime-only dependencies external. See
[`electron.vite.config.ts`](../apps/desktop/electron.vite.config.ts): workspace
packages are aliased to their `src/index.ts` and excluded from
`externalizeDepsPlugin`, so they get bundled, while `@prisma/client`, `ssh2` and
`@pulumi/pulumi` stay external and are loaded from `node_modules` at runtime.

---

## Recipes

### Add an IPC channel

See [IPC Reference → Adding a channel](IPC.md#adding-a-channel-checklist).

### Add a UI module

1. Create `renderer/src/features/<module>/` with a `use<Module>.ts` hook (TanStack
   Query over `invoke`) and a `<Module>Page.tsx`.
2. Add a nav entry in `app/navigation.ts` and a route in `app/router.tsx`.
3. If it needs data, add the IPC channel(s) and a service in `core` (see below).

### Add an Application service / use-case

1. Model the domain in `core/src/domain/…` (entities, value objects, factories
   returning `Result`).
2. Define a **port** in `core/src/application/ports/…` for anything external
   (persistence, an engine, an SDK).
3. Write the **service** in `core/src/application/…` depending only on ports;
   return DTOs and typed errors.
4. Implement the port with an **adapter** in the relevant infrastructure package
   (`database`, `providers`, …).
5. Wire the adapter → service in the **composition root**
   ([`main/container.ts`](../apps/desktop/src/main/container.ts)).
6. Expose it over IPC and consume it from a feature hook.
7. Add unit tests for the domain/service (use an in-memory fake for the port).

### Add a cloud provider

1. Implement the `CloudProvider` interface in `packages/providers/src/<provider>/`
   (mirror `OracleProvider`).
2. Register it with a single `case` in `DefaultProviderFactory`
   ([`registry.ts`](../packages/providers/src/registry.ts)) and add the kind to
   the `IMPLEMENTED` set.
3. Add the provider kind to `PROVIDER_KINDS`/`PROVIDER_LABELS` and its credential
   fields to `CREDENTIAL_SCHEMAS` (both in `core`) if not already present.

That's it — the UI, Application layer and IPC are provider-agnostic and require
no changes.

### Add a deployment template

Add an entry to `DEPLOYMENT_TEMPLATES` in
[`deployment-template.ts`](../packages/core/src/application/deployment/deployment-template.ts):
an `id`, `name`, `description` and a `build(context)` returning ordered
`DeploymentStep[]`. It appears automatically in Templates and Deployments.

### Add an infrastructure template

Add an entry to `INFRASTRUCTURE_TEMPLATES` in
[`infrastructure-template.ts`](../packages/core/src/application/infrastructure/infrastructure-template.ts):
a `build(context)` returning a full `InfrastructurePlan`. It appears in Templates
and can be applied to a project.

### Change the database schema

1. Edit `packages/database/prisma/schema.prisma`.
2. `pnpm --filter @cloudforge/database prisma:generate`
3. `pnpm --filter @cloudforge/database db:bootstrap-sql` (regenerates the inlined
   DDL used by `ensureSchema`).
4. Update the affected repository/mapper and, if needed, the DTOs.

## Testing

- **Vitest** everywhere. Domain and Application logic is tested with in-memory
  fakes for ports (see `project-service.test.ts`, `credential-service.test.ts`).
- Pure builders/validators are unit-tested directly (`validatePlan`,
  `deployment-template`, `oci-signer`, `buildProgram`).
- `pnpm test:coverage` runs the full suite from root via a Vitest workspace.

## Project layout quick map

```
apps/desktop/src/
  main/         lifecycle · window · container (composition root) · ipc/ · security/ · infra/
  preload/      the contextBridge surface (window.cloudforge)
  shared/ipc/   the typed IPC contract (source of truth)
  renderer/src/ app/ (router, layout, theme, command palette) · features/ (modules) · lib/
packages/
  shared core ui database providers pulumi deployment
```

Service-provider adapters live in `packages/service-providers`. Add a new
service by defining its port and use-case service in `core`, implementing the
port in that package, wiring it only in the desktop composition root, and
exposing individual use cases through typed IPC. Do not add non-provisioning
services to `CloudProvider` or Pulumi.
