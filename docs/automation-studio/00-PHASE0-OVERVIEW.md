# Phase 0 — Complete Project Reverse Engineering (Overview)

> **Source of truth: the source code.** This document set was produced by a full reverse-engineering
> pass over the entire monorepo (apps, packages, tools, scripts, CI, tests) plus the sibling
> `ansible-playbook-deploy` repository — not from the existing documentation.
> Generated: 2026-07-16 against `cloudforge` v0.2.33 (commit `ff7ff38`).

## Document set

-| Doc | Contents |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [01-FEATURE-INVENTORY.md](01-FEATURE-INVENTORY.md) | Every feature in CloudForge, by module, as implemented in code |
| [02-SERVICE-INVENTORY.md](02-SERVICE-INVENTORY.md) | Every application service: purpose, methods, dependencies, streaming, workflow relevance |
| [03-IPC-INVENTORY.md](03-IPC-INVENTORY.md) | All 149 invoke channels + 10 event channels, typed, with owning service |
| [04-UI-INVENTORY.md](04-UI-INVENTORY.md) | Every renderer page/action and the IPC channel it calls |
| [05-DOMAIN-DATABASE-INVENTORY.md](05-DOMAIN-DATABASE-INVENTORY.md) | Domain entities/VOs, all 13 Prisma models, all repositories, gaps for a workflow engine |
| [06-AUTOMATION-MATRIX.md](06-AUTOMATION-MATRIX.md) | Every automatable capability scored as a workflow-node candidate |
| [07-DOCS-DISCREPANCIES.md](07-DOCS-DISCREPANCIES.md) | Where `docs/` diverges from the code, and architecture conventions to follow |

## What CloudForge is (from the code)

CloudForge is an **Electron desktop application** (`apps/desktop`, Electron 43 + React 18 +
electron-vite) implementing a full infrastructure lifecycle platform:

**Provision** (Pulumi automation API → Oracle Cloud / AWS) → **Configure** (Ansible profiles run
remotely over SSH) → **Deploy** (SSH step runner, Docker Compose, Jenkins pipelines) → **Manage**
(Nginx, SSL/Certbot, Cloudflare, firewall, containers, terminal).

### Monorepo layout

```
apps/desktop            Electron app: main (composition root, IPC), preload (bridge), renderer (React)
packages/shared         Kernel: Result<T,E>, AppError taxonomy, branded IDs, constants
packages/core           Domain (Project, Credential aggregates) + Application services + Ports
packages/database       Prisma/SQLite adapter: 10 repositories, schema bootstrap (no migrations dir)
packages/providers      CloudProvider adapters: Oracle (hand-signed OCI REST), AWS (EC2/STS SDK)
packages/pulumi         InfrastructureEngine adapter: Pulumi automation API, inline programs, local file backend
packages/service-providers  Cloudflare adapter (REST v4 + GraphQL analytics)
packages/deployment     SSH adapters: deployer, Ansible manager, containers, nginx, certbot, terminal, Jenkins HTTP
packages/ui             Presentational component library (shadcn-style)
tools/deploy-app, tools/provision-app   EMPTY placeholder dirs (not in workspace, no references)
```

### Architecture in one paragraph

Strict hexagonal layering. `packages/core` defines **ports** (25+ interfaces); adapter packages
implement them; the **composition root** is `apps/desktop/src/main/container.ts`, which wires 19
exposed services (+1 internal) with manual constructor injection over a SQLite DB at
`<userData>/cloudforge.db`. Every async operation returns `Result<T, AppError>` — nothing throws
across layer boundaries. The renderer talks only to `window.cloudforge.invoke/subscribe`, a single
typed bridge over a 149-channel contract (`apps/desktop/src/shared/ipc/contract.ts`); every IPC
response crosses as an `IpcResult` envelope (`{ok,value}|{ok:false,error}`). Long-running
operations take a client-generated `streamId` and stream progress over one of six `*:log`/event
channels. Secrets are encrypted at rest via Electron `safeStorage` (or AES-256-GCM file-key
fallback) and **never cross IPC** except explicit reveal channels; SSH targets are resolved
main-side from encrypted credential IDs, with SHA-256 host-key pinning on every connection.

### Load-bearing facts for Automation Studio

1. **Every capability already flows through an application service returning `Result<T,E>`** —
   a workflow engine can branch on `.ok` uniformly and orchestrate services directly, without
   duplicating business logic.
2. **Streaming is uniform**: all long ops accept an event sink (`EngineEventSink`,
   `DeployEventSink`, `AnsibleEventSink`, `NginxEventSink`, `CertificateEventSink`) with
   `{stream: 'step'|'stdout'|'stderr'|'error', message}` events, correlated by `streamId`.
   Cancellation is via `AbortController` maps keyed by `streamId` (deploy + ansible today).
3. **Cross-service orchestration already exists in code** (natural precedents for workflow edges):
   - `InfrastructureService.apply` → `ManagedVpsTargetSyncService.sync` → VPS target upsert (with 20×3s SSH-readiness retry)
   - `JenkinsPipelineService.save` → Cloudflare DNS ensure → Nginx site upsert
   - `SslService.issue` → DNS ensure → Certbot → Nginx SSL config → settings persistence
   - Container background timers: SSL auto-renew (`renewDue`), Cloudflare auto-sync, startup reconciliation
4. **A preview→apply token gate exists**: `infra:apply` requires a one-use `previewToken`
   fingerprinted to the plan, issued by `infra:preview`. Workflows must preview immediately before apply.
5. **Two ports have no wrapping application service** (`AnsibleManager`, `ContainerManager`) —
   IPC handlers call them directly. Automation Studio should either wrap them in services or
   invoke the ports the same way handlers do.
6. **No workflow-adjacent persistence exists yet**: no workflow/execution/scheduling tables, no
   entity versioning, no optimistic concurrency (except firewall `expectedRules`), no soft deletes.
   Only `Activity` (append-only audit) and `Deployment` (run history with crash recovery) exist.
7. **The sibling `ansible-playbook-deploy` repo is NOT integrated.** CloudForge embeds its own
   playbooks as TypeScript strings (`packages/deployment/src/ansible-playbooks.ts`) and executes
   them **on the target VPS** (`-i localhost, -c local`) inside a venv it bootstraps at
   `/opt/cloudforge/ansible`. (The sibling repo also contains committed private keys and a
   hardcoded Slack webhook — a pre-existing security issue, flagged in 07.)

### Runtime state locations

| What                         | Where                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Database                     | `<userData>/cloudforge.db` (SQLite; pre-migration backups `*.bak-<ts>`)                  |
| Secret key (cipher fallback) | `<userData>/secret.key` (0600)                                                           |
| Pulumi home/state/passphrase | `<userData>/pulumi/` (local `file://` backend)                                           |
| Logs                         | `<userData>/logs/cloudforge.log` (pino, trace-level, 10 MiB rotation, retention pruning) |
| Remote Ansible runtime       | `/opt/cloudforge/ansible` venv on each VPS                                               |
| Remote compose projects      | `/opt/cloudforge/compose/<project>`, `/opt/cloudforge/apps/<profile>`                    |
| Remote nginx backups         | `/var/lib/cloudforge/nginx/backups` (tar.gz)                                             |
