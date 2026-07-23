<div align="center">

# CloudForge Documentation

**Modern Infrastructure Platform** — Provision. Configure. Deploy. Manage.

</div>

This documentation describes CloudForge, a local-first Electron desktop
application for provisioning, configuring, deploying and managing cloud
infrastructure. OCI provisioning, SSH deployments, SSH keys, remote containers,
backup/restore and the packaged update workflow are implemented.

## Table of contents

| Document                                                                    | What it covers                                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Getting Started](GETTING-STARTED.md)                                       | **Run, test and use** the app end to end, plus troubleshooting                                                    |
| [First OCI Instance](FIRST-INSTANCE.md)                                     | Provision, SSH into, discover, and safely delete OCI instances entirely from CloudForge                           |
| [Amazon Web Services](AWS.md)                                               | Configure AWS, attach projects, discover EC2, and Preview/Apply/Destroy VPC, EC2 and EBS infrastructure           |
| [Ansible & Nginx](ANSIBLE.md)                                               | Configure any VPS, run generic profiles, and safely manage domain-to-port Nginx routes                            |
| [Nginx Manager](NGINX-MANAGER.md)                                           | Dedicated per-target Nginx dashboard, editor, logs, backups, validation, reload, and rollback                     |
| [VPS Runtime](VPS-RUNTIME.md)                                               | The authoritative topology model: networks, ownership, adoption, drift, preview/apply, and firewall requirements  |
| [Runtime migration](RUNTIME-MIGRATION.md)                                   | What the unified runtime model changes on an existing VPS (nothing), and how to verify that yourself              |
| [Runtime topology synchronization](RUNTIME-TOPOLOGY-MIGRATION.md)           | Audit and migration design for Jenkins, Nginx, SSL, Cloudflare, and live firewall synchronization                 |
| [Runtime production readiness audit](RUNTIME-PRODUCTION-READINESS-AUDIT.md) | Release-candidate verification, issues found and fixed, safety conclusions, and live staging checklist            |
| [Runtime refactor phases](RUNTIME-REFACTOR-PHASES.md)                       | Phase-by-phase record of the runtime refactor: purpose, every bug fixed, every decision, and how to test each     |
| [Firewall Manager](FIREWALL-MANAGER.md)                                     | Live provider-independent instance firewall synchronization and in-place OCI Security List updates                |
| [SSL & Domains](SSL-DOMAINS.md)                                             | Cloudflare Origin CA and Let’s Encrypt issuance, inspection, Nginx integration, rollback, and renewal             |
| [Cloudflare](CLOUDFLARE.md)                                                 | Account, zones, DNS, SSL/TLS, cache, analytics, security and edge-service integration                             |
| [Jenkins Pipelines](JENKINS-PIPELINES.md)                                   | Per-VPS Jenkins folders, private Git checkout, parameterized builds, domain automation, and status                |
| [Infrastructure updates](INFRASTRUCTURE-UPDATES.md)                         | Pulumi identity, update/replace behavior, destructive previews, and mandatory preview approval                    |
| [Configuration & Credentials](CONFIGURATION.md)                             | Every credential/key you must provide (Oracle, SSH, …) and **how to get it**                                      |
| [Overview](OVERVIEW.md)                                                     | What CloudForge is, core concepts, glossary, end-to-end user workflows                                            |
| [Architecture](ARCHITECTURE.md)                                             | Clean Architecture layers, dependency rules, the Electron process model, the secure IPC contract, error handling  |
| [Packages](PACKAGES.md)                                                     | Every workspace package: purpose, public exports, key files                                                       |
| [Modules](MODULES.md)                                                       | Every UI module: behaviour and data flow                                                                          |
| [IPC Reference](IPC.md)                                                     | The complete typed IPC contract — all channels, streaming events, the `Result` envelope, and how to add a channel |
| [Data Model](DATA-MODEL.md)                                                 | The Prisma/SQLite schema — all 12 tables and conventions                                                          |
| [Security](SECURITY.md)                                                     | The security model: encryption, keychain, hardening, threat notes                                                 |
| [Privacy](PRIVACY.md)                                                       | Local data, network activity, diagnostic boundaries, and retention                                                |
| [License](LICENSE.md)                                                       | Current CloudForge licensing status and third-party notices                                                       |
| [Development](DEVELOPMENT.md)                                               | Setup, scripts, coding conventions, and step-by-step "how to add X" recipes                                       |
| [Packaging](PACKAGING.md)                                                   | Building distributables and runtime prerequisites                                                                 |
| [Move State & Release](MOVING-AND-RELEASING.md)                             | Transfer the database safely and publish tested Windows installers from Git tags                                  |
| [Completion Report](ROADMAP.md)                                             | Implemented phases, verification evidence and external release requirements                                       |

Project-level entry points: the top-level [README](../README.md) and the
[CHANGELOG](../CHANGELOG.md) (a phase-by-phase build history).

The installed desktop application bundles these Markdown files into the
**Documentation** page. Use the global help button to open the guide related to
the current module; no internet connection is required to read bundled guides.

## At a glance

|                            |                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**                   | Cross-platform desktop app (Windows / macOS / Linux)                                                                                                                               |
| **Shell**                  | Electron 43 · electron-vite · React 18 · TypeScript (strict)                                                                                                                       |
| **UI**                     | TailwindCSS · Radix UI · Framer Motion · Lucide · TanStack Query · Zustand                                                                                                         |
| **Backend (main process)** | Node.js · Prisma 5 + SQLite                                                                                                                                                        |
| **Infra engine**           | Pulumi Automation API 3 (encapsulated; never exposed to the UI)                                                                                                                    |
| **Configuration engine**   | Verified SSH plus self-managed remote Ansible                                                                                                                                      |
| **Service integrations**   | Cloudflare DNS/edge management and per-VPS Jenkins Pipelines                                                                                                                       |
| **Cloud providers**        | Oracle Cloud and AWS provisioning, discovery, lifecycle and dependency-safe destruction                                                                                            |
| **Architecture**           | Monorepo (pnpm + Turborepo), Clean Architecture / DDD, 8 packages + 1 app                                                                                                          |
| **Tests**                  | 739 unit tests (Vitest), including cross-feature runtime synchronization, generated shell parsed by a real `sh -n`, portable backup, VPS preflight, Ansible YAML, and safety paths |
| **Quality gates**          | `typecheck` · `lint` (ESLint 9, type-checked) · `test` · `build`                                                                                                                   |

## Reading order

- **Just want to run it?** Go straight to [Getting Started](GETTING-STARTED.md)
  and [Configuration & Credentials](CONFIGURATION.md).
- **New to the project?** Start with [Overview](OVERVIEW.md), then
  [Architecture](ARCHITECTURE.md).
- **Contributing code?** Read [Architecture](ARCHITECTURE.md),
  [Packages](PACKAGES.md) and [Development](DEVELOPMENT.md).
- **Integrating / extending?** See [IPC Reference](IPC.md) and the "recipes" in
  [Development](DEVELOPMENT.md) (add a provider, module, IPC channel).
- **Shipping?** See [Packaging](PACKAGING.md) and [Security](SECURITY.md).
- **Checking completion and release requirements?** See [Completion Report](ROADMAP.md).
