# Overview

## What is CloudForge?

CloudForge is a desktop application that lets developers, DevOps engineers,
startups and small teams **manage real cloud infrastructure end to end from a
graphical interface** — no command line required.

Under the hood it orchestrates two engines:

- **Pulumi Automation API** — the Infrastructure-as-Code engine that provisions
  and destroys cloud resources.
- **SSH** — configures freshly-provisioned hosts by running idempotent shell
  steps (install Docker, harden with UFW/fail2ban, launch an app).

Crucially, **the user never interacts with Pulumi or SSH directly**. The
application is the product; the engines are implementation details hidden behind
the Application layer. This is the guiding product principle: _CloudForge is the
operating system for cloud infrastructure._

## Core principles

Every design decision serves these five properties:

- **Reproducible** — infrastructure is described declaratively (an
  `InfrastructurePlan`) and provisioned identically every time.
- **Configurable** — projects, providers, templates and settings are all editable.
- **Versioned** — Pulumi state, deployment history and an activity/audit log.
- **Extensible** — new providers, templates and plugins are added by
  implementing one interface; nothing else changes.
- **Provider-independent** — no provider-specific logic leaks into the UI or the
  Application layer. Everything provider-specific lives behind the
  `CloudProvider` contract.

## Target users

Developers · DevOps engineers · Startups · Freelancers · Small companies ·
Infrastructure engineers.

## Key concepts

| Concept                   | Meaning                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**               | The aggregate root: one managed infrastructure. Holds name, environment, region, provider, tags, variables and its infrastructure plan + deployment history.        |
| **Credential**            | Encrypted secret material for one external service (Oracle, AWS, GitHub, SSH key, …). Stored encrypted; revealed only on explicit request.                          |
| **Cloud Provider**        | A plugin implementing the `CloudProvider` contract (test connection, list regions/shapes/…). Oracle Cloud ships first.                                              |
| **Infrastructure Plan**   | A provider-agnostic, declarative description of desired resources (networks, subnets, firewalls, compute, volumes). Interpreted by the engine into cloud resources. |
| **Infrastructure Engine** | The `InfrastructureEngine` port; implemented by Pulumi (`PulumiEngine`). Runs preview / apply / destroy / refresh / outputs.                                        |
| **Stack**                 | One Pulumi stack = one environment of one project. Derived automatically as `<project-slug>-<id-prefix>` / `<environment>`.                                         |
| **Deployment**            | Running a **deployment template** (Docker Host, Node, WordPress, …) on a host over SSH. Recorded with status and streamed logs.                                     |
| **Template**              | Reusable blueprint. Two kinds: _infrastructure templates_ (produce a plan) and _deployment templates_ (produce SSH steps).                                          |
| **Plugin**                | A marketplace extension contributing to an extension point: provider, template, widget, theme or ansible-role.                                                      |
| **Activity**              | An audit-log entry recorded on notable events (project created, infra applied, deployment succeeded/failed). Powers the Logs module and dashboard timeline.         |

## The end-to-end workflow

A typical journey through the app:

```
1. Add a credential          Secrets → "Add Credential" → Oracle Cloud fields
   (encrypted at rest)        (and an "SSH Key" credential for deployments)

2. Test the provider          Cloud Providers → "Test connection"
                              → account info + list regions / shapes

3. Create a project           Projects → "New Project" (name, environment, region)

4. Compose infrastructure     Infrastructure → pick project → add resources
   (or apply a template)       (network, subnet, firewall, compute, volume)
                              → Preview  → Apply   (structured resource progress
                                plus the live Pulumi log stream)

5. Deploy an application       Deployments → pick project + template + host + SSH key
                              → Deploy   (live SSH log stream, per-step)

6. Observe                     Dashboard (stats, activity, charts) · Logs
                              (searchable / filterable / exportable feed)
```

Each numbered step maps to a UI module (see [Modules](MODULES.md)) and a set of
IPC channels (see [IPC Reference](IPC.md)).

## The 14 modules

Dashboard · Projects · Cloud Providers · Templates · Infrastructure ·
Deployments · Containers · Logs · Secrets · SSH Keys · Settings · Built-in
Extensions · Updates · About.

All routes are functional. Containers use verified SSH rather than an exposed
Docker socket, and SSH Keys uses the encrypted Credential store as its source of
truth. See the [Completion Report](ROADMAP.md) for delivered scope.

## Glossary

- **Aggregate root** — the entry entity that guards a cluster of domain objects
  (here, `Project`).
- **Port** — an interface defined by the Application layer that Infrastructure
  adapters implement (Dependency Inversion).
- **Adapter** — a concrete implementation of a port (e.g. `PrismaProjectRepository`).
- **DTO** — Data Transfer Object; a plain, serializable shape that crosses the
  IPC boundary to the renderer.
- **Composition root** — the single place (`apps/desktop/src/main/container.ts`)
  that wires adapters into services.
- **`Result<T, E>`** — a functional success/failure type used instead of throwing
  for expected errors.
