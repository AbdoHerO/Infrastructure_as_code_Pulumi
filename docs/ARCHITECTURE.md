# CloudForge Architecture

This document describes the architectural foundations laid in **Phase 1** and the
principles every later phase must uphold. The goal is a codebase that remains
maintainable for a decade: SOLID, Clean Architecture, Domain-Driven Design and
provider independence.

## 1. Guiding principles

- **Clean Architecture** — dependencies point inward. Presentation depends on
  Application, which depends on Domain. Infrastructure implements ports defined by
  the inner layers. The Domain layer depends on nothing.
- **No business logic in React** — components render state and dispatch intent.
  All rules live in the Application/Domain layers.
- **Provider independence** — the UI and Application layers speak in domain terms.
  Provider specifics live behind a single `CloudProvider` interface (Phase 5).
- **Explicit errors** — expected failures flow through the `Result` type, not
  exceptions. Errors are typed (`AppError` hierarchy) and serializable.
- **Secure by default** — context isolation on, Node integration off, a strict CSP,
  and a single typed IPC surface.

## 2. Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ Presentation   apps/desktop/src/renderer (React)                  │
│                – features/ (14 modules), app shell, command palette │
├──────────────────────────────────────────────────────────────────┤
│ IPC boundary   apps/desktop/src/{preload, shared/ipc, main/ipc}   │
│                – typed contract, secure context bridge, streaming  │
├──────────────────────────────────────────────────────────────────┤
│ Application    packages/core/src/application                      │
│                – services (use cases), ports, DTOs, templates      │
├──────────────────────────────────────────────────────────────────┤
│ Domain         packages/core/src/domain                          │
│                – entities, value objects, invariants               │
├──────────────────────────────────────────────────────────────────┤
│ Infrastructure packages/{database, providers, pulumi, deployment} │
│                – Prisma/SQLite · Oracle (OCI) · Pulumi · SSH       │
└──────────────────────────────────────────────────────────────────┘
```

Dependencies point **inward**: Infrastructure adapters implement ports defined
by the Application layer; the Domain depends on nothing but `shared`. The
composition root (`apps/desktop/src/main/container.ts`) is the only place that
wires adapters into services.

The **shared kernel** (`packages/shared`) sits beside every layer. It is
framework- and environment-agnostic (no Node- or browser-only APIs) so it can be
imported by the main process, the renderer and every package alike.

> For the per-package breakdown see [Packages](PACKAGES.md); for the full IPC
> catalogue see [IPC Reference](IPC.md).

## 3. Monorepo & build model

- **pnpm workspaces** + **Turborepo** orchestrate tasks with caching.
- Internal packages are published **as TypeScript source** (their `exports` point at
  `src/index.ts`). The bundler (Vite/esbuild via `electron-vite`) transpiles them as
  first-party code — there is no separate library build step to keep in sync.
- A single strict `tsconfig.base.json` is extended by every package. Strictness
  includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax`.

## 4. The Electron process model

| Process      | Responsibility                                                             |
| ------------ | -------------------------------------------------------------------------- |
| **main**     | App lifecycle, window management, IPC handlers, all privileged work        |
| **preload**  | Exposes exactly one typed bridge (`window.cloudforge`) via `contextBridge` |
| **renderer** | React application; no Node access, talks only through the bridge           |

### Secure IPC contract

`apps/desktop/src/shared/ipc/contract.ts` is the single source of truth. Each
channel declares its `request`/`response` types:

```ts
export interface IpcContract {
  'app:getInfo': { request: void; response: AppInfo };
}
```

- **Main** registers handlers through `registerHandler`, which wraps the return
  value (or thrown error) into a serialized `IpcResult` envelope — the renderer
  always receives structured data, never a raw exception.
- **Preload** exposes a single generic `invoke(channel, payload)` typed against the
  contract. The renderer cannot see `ipcRenderer`.
- **Renderer** calls `invoke()` (throws `IpcCallError` for TanStack Query) or
  `tryInvoke()` (returns a `Result`).

Adding a feature is: add channel(s) to the contract → add a handler module →
register it in `main/ipc/index.ts`. Types keep all three processes in lock-step.

## 5. Security model

- `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`.
- A strict Content-Security-Policy is applied to every response and declared in the
  renderer HTML.
- External navigations and `window.open` are delegated to the OS browser and denied
  inside the app; `<webview>` attachment is blocked.
- Secrets (Phase 4) are never stored in plaintext: OS keychain first, Electron
  `safeStorage` as a fallback.

## 6. Error handling

- `Result<T, E>` — functional success/failure used across Application/Domain.
- `AppError` — abstract base with a stable `ErrorCode`, structured `context` and a
  `toJSON()` for IPC transport. Subclasses: `ValidationError`, `NotFoundError`,
  `ProviderError`, `InfrastructureError`, `DeploymentError`, `CredentialError`, …
- `toAppError(unknown)` normalises any thrown value at boundaries.

## 7. Design system

`packages/ui` owns the visual language: a Tailwind **preset** with HSL
CSS-variable design tokens (driving light/dark from one set), the `cn` class
merger, and shared presentational components. Apps consume the preset and point
`content` at their own sources. No component contains business logic.

## 8. Conventions

- Files: `kebab-case.ts`; React components `PascalCase.tsx`.
- One public entry per package (`src/index.ts` barrel).
- Every module ships tests for pure logic and documentation for its feature.
- Nothing is merged with a failing typecheck, lint, test or build.
