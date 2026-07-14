# Modules

The renderer is organised as one folder per module under
[`apps/desktop/src/renderer/src/features/`](../apps/desktop/src/renderer/src/features/).
Navigation and routes are declared in `app/navigation.ts` and `app/router.tsx`.
Each module follows the same pattern: a `use*.ts` hook (TanStack Query over the
IPC client) + presentational components composed from `@cloudforge/ui`. **No
business logic lives in components.**

The sidebar groups modules by concern:

- **Overview** — Dashboard
- **Manage** — Projects, Infrastructure, Deployments, Containers, Ansible
- **Configure** — Cloud Providers, Templates, Secrets, SSH Keys
- **Observe** — Logs
- **System** — Plugin Marketplace, Updates, Settings, About

---

## Dashboard (`/`)

Landing page. Summary stat cards (projects, deployments, providers,
infrastructure), the **Activity timeline** (live), a **Projects-by-environment**
bar chart, and a **System** card showing runtime versions and IaC-engine
availability. Channels: `projects:list`, `activity:list`, `infra:engineStatus`,
`app:getInfo`.

## Projects (`/projects`)

Create, list and delete projects. Creation uses React Hook Form + Zod; the form
validates client-side and the domain re-validates server-side. Deletion is
confirmed via toast feedback. Channels: `projects:*`.

## Cloud Providers (`/providers`)

Lists credentials whose kind is a cloud provider. Per card: **Test connection**
(shows account info), on-demand **region/shape discovery**, and OCI account
instance inventory. Unmanaged instances can be terminated after exact-name
confirmation; managed instances should be removed from their Pulumi stack.
Backed by the `ProviderConnectionService` → `OracleProvider`. Channels:
`providers:*` + `credentials:list`.

## Templates (`/templates`)

Browse **infrastructure templates** (Web Server, AI Server, Database Host,
Kubernetes Node) and **deployment templates** (Docker Host, Nginx, Node,
Next.js, WordPress, Ollama). "Apply to project" generates a plan from an infra
template and saves it. A **"Your templates"** section lists user-saved custom
templates (created via Infrastructure → "Save as template") with apply-to-project
and delete. Channels: `infra:templates`, `infra:applyTemplate`,
`infra:customTemplates`, `infra:applyCustomTemplate`, `infra:deleteTemplate`,
`deploy:templates`.

## Infrastructure (`/infrastructure`)

The core provisioning surface. Pick a project, then **compose a declarative
plan**: add/remove/edit networks, subnets, firewalls (with a rules editor),
compute instances and volumes — use **Add resource → Compute instance** to add
as many instances as you like. Each resource has an **OCI-aware editor**: compute
shapes and availability domains are populated **live from the linked account**
(with a built-in fallback), OCPUs/memory appear for flexible shapes, the image is
a curated OS list or a specific image OCID, and network/subnet/instance
references are dropdowns of the plan's own resources. **Save as template** stores
the current plan for reuse. Client-side `validatePlan` surfaces issues. Actions
**Save plan / Preview / Apply / Destroy** run against the Pulumi engine with both
a live `LogTerminal` and structured progress. The progress panel is
indeterminate—Oracle does not expose a reliable percentage—and shows the current
real resource operation, per-resource Ready/Failed states, and distinct final
states for Preview, Apply, Refresh and Destroy. Preview/apply require a linked
provider credential. Managed stacks can be discovered and destroyed even when
their project row no longer exists. Channels: `infra:getPlan`, `infra:savePlan`,
`infra:preview`, `infra:apply`, `infra:destroy`, `infra:outputs`,
`infra:managedStacks`, `infra:destroyStack`, `infra:saveTemplate`; event
`engine:log`.

## Deployments (`/deployments`)

Run a deployment template on a host over SSH. Choose project, template, host,
port, SSH user and an **SSH key or password credential**; optionally a container image. The
run streams per-step output to a `LogTerminal`; history is listed with status
badges. The main process decrypts the SSH key from the Credential Manager and
never sends it back to the renderer. Channels: `deploy:templates`, `deploy:run`,
`deploy:list`; event `deploy:log`.

## Containers (`/containers`)

Manage a Docker host through verified SSH transport. The module inventories
containers, starts/stops/restarts/removes them, reads logs and live stats, and
deploys validated Compose YAML. The Docker API is never exposed over an
unauthenticated TCP socket. Channels: `containers:*`.

## Ansible (`/ansible`)

Configure any reachable Linux VPS with an SSH key or password and a pinned host
fingerprint. The module bootstraps an isolated remote Ansible runtime, runs
generic Docker, Dockhand, Portainer, Jenkins and Nginx profiles, streams real
output, and supports cancellation. Its Nginx tab manages CloudForge-owned
domain-to-port proxies with `nginx -t`, rollback, reload, and safe removal.
Channels: `ansible:*`; event `ansible:log`. See [the Ansible guide](ANSIBLE.md).

## Logs (`/logs`)

Two tabs. **Activity** — a searchable, category-filterable, **JSON-exportable**
activity feed built on the reusable `ActivityTimeline`. **Application log** — the
raw `cloudforge.log` file (path, copy-path, open-folder, and a live tail): every
IPC call, streamed engine output, crashes and forwarded renderer errors, with
secrets/payloads never written. Channels: `activity:list`, `logs:info`,
`logs:tail`, `logs:openFolder`, `logs:report`.

## Secrets (`/secrets`) — the Credential Manager

Securely store, reveal and delete provider/service secrets. A **security banner**
shows whether encryption is backed by the OS keychain. The **add dialog is
schema-driven** (`CREDENTIAL_SCHEMAS`): choosing a kind renders exactly its
fields (secret fields masked, PEM fields multiline). The **reveal dialog**
decrypts on demand, masks secret fields by default, and offers copy-to-clipboard.
Channels: `credentials:*`, `security:status`.

## SSH Keys (`/ssh-keys`)

Generate encrypted Ed25519 or RSA-3072 key pairs, import PEM private keys,
validate passphrases, show OpenSSH public keys and SHA-256 fingerprints, and
perform protected private-key reveal/delete actions. The encrypted Credential
record is the single source of truth. Channels: `sshKeys:*`.

## Settings (`/settings`)

Tabbed, live-persisted configuration: **General** (log retention),
**Appearance** (theme mode via the Zustand store, reduced motion),
**Deployment** (confirm destructive actions, default region), **Security**
(encryption status plus database/Pulumi-state backup and restore). Channels:
`settings:*`, `security:status`, `backup:*`.

## Built-in Extensions (`/plugins`)

Install and enable trusted, bundled declarative contributions. Active
contributions affect the running renderer (for example the Nord theme). The
module deliberately does not download or execute third-party JavaScript.
Channels: `plugins:*`.

## Updates (`/updates`)

Uses `electron-updater` against the configured GitHub Releases feed and exposes
checking, available, downloading percentage, downloaded, error and
restart-to-install states. Packaged builds receive events over `updates:state`;
development builds clearly report that update checks require packaging.

## About (`/about`)

Product/branding information (name, subtitle, tagline, version).

---

## Cross-cutting UI

- **App shell** (`app/layout/`) — resizable sidebar rail + draggable titlebar +
  routed content. Mounts the command palette and toaster.
- **Command palette** (`app/command/`) — ⌘K / Ctrl+K fuzzy-search and jump to any
  module (cmdk), wired to a global keyboard-shortcut hook and the titlebar search
  field.
- **Theme** (`app/theme/`) — Zustand store (`light` / `dark` / `system`),
  persisted to `localStorage`, applied by toggling the `dark` class on `<html>`.
- **Providers** (`app/providers.tsx`) — `QueryClientProvider` + `TooltipProvider`.
- **Toasts** — `sonner` via the design system, used for action feedback across
  modules.
