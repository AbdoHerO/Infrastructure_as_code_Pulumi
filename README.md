<div align="center">

# CloudForge

### Modern Infrastructure Platform

**Provision. Configure. Deploy. Manage.**

A production-grade desktop application to provision, configure, deploy and manage
cloud infrastructure through a modern graphical interface — no command line required.

</div>

---

## What is CloudForge?

CloudForge is the **operating system for cloud infrastructure**. It lets developers,
DevOps engineers and small teams manage real cloud infrastructure end to end from a
beautiful desktop app.

Under the hood it uses the **Pulumi Automation API** as its infrastructure engine and
**Ansible** for post-provisioning configuration — but users never touch either
directly. The application is the product; the tooling is an implementation detail.

### Core principles

Everything is **reproducible**, **configurable**, **versioned**, **extensible** and
**provider-independent**. No provider-specific logic ever leaks into the UI.

## Technology

| Layer          | Technology                                                       |
| -------------- | ---------------------------------------------------------------- |
| Desktop shell  | Electron, Vite, `electron-vite`                                  |
| UI             | React, TypeScript, TailwindCSS, shadcn/ui, Framer Motion, Lucide |
| State / data   | Zustand, TanStack Query, React Hook Form, Zod                    |
| Backend (main) | Node.js, TypeScript, Prisma + SQLite, Pino                       |
| Infra engine   | Pulumi Automation API                                            |
| Configuration  | Ansible, SSH, Docker SDK                                         |

## Monorepo layout

```
cloudforge/
├─ apps/
│  └─ desktop/          # Electron app: main · preload · renderer (React)
└─ packages/
   ├─ shared/           # Shared kernel: Result, errors, branded IDs, types
   ├─ ui/               # Design system: Tailwind preset, tokens, components
   ├─ core/             # Domain + Application layers: entities, ports,
   │                    #   services, templates & the plugin system
   ├─ database/         # Prisma schema & repository implementations
   ├─ providers/        # CloudProvider contract impls (Oracle Cloud)
   ├─ pulumi/           # Pulumi Automation API engine (InfrastructureEngine)
   └─ deployment/       # SSH deployment engine (Deployer)
```

Cross-cutting concerns follow **Clean Architecture**: `core` owns the Domain and
Application layers (entities, value objects, ports and use-case services) and
depends only on `shared`; `database`, `providers`, `pulumi` and `deployment`
are Infrastructure adapters that implement `core`'s ports; the Electron app is
the Presentation layer and talks to services only through the typed IPC contract.

## Documentation

Full documentation lives in [`docs/`](docs/README.md):

- [Overview](docs/OVERVIEW.md) · [Architecture](docs/ARCHITECTURE.md) ·
  [Packages](docs/PACKAGES.md) · [Modules](docs/MODULES.md)
- [IPC Reference](docs/IPC.md) · [Data Model](docs/DATA-MODEL.md) ·
  [Security](docs/SECURITY.md)
- [Development](docs/DEVELOPMENT.md) · [Packaging](docs/PACKAGING.md)

## Getting started

**Prerequisites:** Node.js ≥ 20.18 and pnpm ≥ 9.

```bash
pnpm install        # install the workspace
pnpm desktop        # run the desktop app in development
```

### Workspace scripts

| Command          | Description                               |
| ---------------- | ----------------------------------------- |
| `pnpm desktop`   | Run the Electron app in development (HMR) |
| `pnpm build`     | Build every package and the desktop app   |
| `pnpm typecheck` | Type-check the whole workspace            |
| `pnpm lint`      | Lint the whole workspace                  |
| `pnpm test`      | Run all unit tests                        |
| `pnpm format`    | Format the codebase with Prettier         |

## Roadmap

CloudForge is built in disciplined phases; each ends green (typecheck, lint, test,
build) before the next begins.

| Phase  | Scope                                                                |
| ------ | -------------------------------------------------------------------- |
| **1**  | ✅ Monorepo foundation, tooling, shared kernel, design system, shell |
| **2**  | ✅ Domain model, Prisma/SQLite database, repositories, secure IPC    |
| **3**  | ✅ Design system (Radix), navigation, command palette, theming       |
| **4**  | ✅ Credential Manager (OS keychain + encryption) and Settings        |
| **5**  | ✅ Cloud provider interface + Oracle Cloud + connection testing      |
| **6**  | ✅ Pulumi Automation API engine (preview/apply/destroy/refresh)      |
| **7**  | ✅ Infrastructure module (plan editor, live provisioning)            |
| **8**  | ✅ Deployment pipeline (SSH) + deployment templates                  |
| **9**  | ✅ Live logs, activity timeline, dashboard charts                    |
| **10** | ✅ Templates, plugin system, marketplace, updates                    |
| **11** | ✅ Hardening, coverage, packaging (electron-builder)                 |

All fourteen modules are implemented. See [docs/PACKAGING.md](docs/PACKAGING.md)
for building distributables and the runtime prerequisites (Pulumi CLI, Ansible).

## License

Proprietary — all rights reserved.
