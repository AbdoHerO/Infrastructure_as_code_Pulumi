# Phase 0 — Complete UI Inventory (renderer)

Root: `apps/desktop/src/renderer/src`. 23 feature folders. Hash router, single `AppShell`
(Sidebar + Titlebar + Outlet + CommandPalette + Toaster).

## Shell & navigation
- **Sidebar** (`app/layout/navigation.ts`):
  - Overview: Dashboard `/`, Documentation `/documentation`
  - Manage: Projects, Infrastructure, Deployments, Containers, Ansible, Nginx, Firewall,
    SSL & Domains, Cloudflare, Jenkins Pipelines, SSH Terminal
  - Configure: Cloud Providers, Templates, Secrets, SSH Keys
  - Observe: Logs
  - System: Plugin Marketplace `/plugins`, Updates, Settings, About
- **Command palette**: ⌘K/Ctrl+K — navigation only (no action commands). *Automation Studio
  could register workflow actions here.*
- **Keyboard shortcuts**: only ⌘K. **Titlebar**: search, per-route contextual help → `/documentation?doc=…`, theme cycle.
- **State**: TanStack React Query for all server state (per-feature `use*.ts` hooks);
  Zustand for palette + persisted theme; Context for the app-wide confirmation dialog.
- **Streaming UI**: shared `LogTerminal` (packages/ui) fed by `subscribe('*:log')` filtered by a
  per-page `crypto.randomUUID()` streamId. Interactive PTY via `@xterm/xterm` (Terminal page only).
- **Confirmation policy**: no `window.confirm` (enforced by test); destructive actions use
  `useConfirmation()` or `NameConfirmationDialog` (type-the-name).

## Actions per feature (→ IPC channel)

### Dashboard
Read-only stats/activity (`projects:list`, `activity:list`, `app:getInfo`, `infra:engineStatus`).
Links to getting-started docs when empty.

### Projects
- New Project (form: name/region/environment/provider/description) → `projects:create`
- Edit → `projects:update` · Link/unlink provider → `projects:update`
- Delete (confirm) → `projects:delete`

### Cloud Providers
- Test connection → `providers:test`
- Load regions/shapes/AZs/images/resources/instances → `providers:list*`
- Instance Start/Stop/Reboot (confirm on stop/reboot) → `providers:instanceAction`
- Terminate (type-name confirm) → `providers:terminateInstance`

### Secrets
- Add credential (schema-driven form per kind) → `credentials:create`
- Reveal (masked, show/copy) → `credentials:reveal` · Delete (confirm) → `credentials:delete`

### SSH Keys
- Generate → `sshKeys:generate` · Import → `sshKeys:import`
- Copy public / copy private (confirm → `sshKeys:revealPrivate`) / export file → `sshKeys:exportPrivate`
- Delete (type-name) → `sshKeys:delete`

### Infrastructure (project-scoped)
- Add resource (network/subnet/firewall/compute/volume) — local plan editing
- Save plan → `infra:savePlan` · Save as template → `infra:saveTemplate`
- Preview → `infra:preview` ⚡engine:log · Apply (destructive-change confirm) → `infra:apply`
- Destroy (confirm) → `infra:destroy` · Refresh → `infra:refresh`
- Managed stacks panel: Destroy stack → `infra:destroyStack`
- Outputs read → `infra:outputs`; SSH panel: materialize key + copy command → `sshKeys:materializePrivate`, `app:copyText`
- Structured per-resource progress bars + LogTerminal from `engine:log`

### Deployments
- Inspect host key → `deploy:inspectHostKey` · Deploy → `deploy:run` ⚡deploy:log
- Cancel (confirm) → `deploy:cancel` · History → `deploy:list`

### Containers
- Load → `containers:list` · Start/Stop/Restart/Remove (confirms) → `containers:action`
- Logs → `containers:logs` · Stats → `containers:stats`
- Deploy Compose (name + YAML) → `containers:deployCompose`

### Ansible
- Target editor (save/update/delete/inspect fingerprint) → `ansible:*Target`, `ansible:inspectHostKey`
- Preflight → `ansible:preflight` · Prepare VPS (repair, confirm) → `ansible:repair` ⚡
- Profile states → `ansible:profileStates` · Run profile → `ansible:run` ⚡ansible:log
- Jenkins: verify/restart → `ansible:jenkinsAction` ⚡; access reveal → `ansible:access`
- Nginx tab: load sites → `ansible:nginxSites`; apply domain → `ansible:nginxUpsert` ⚡;
  remove (confirm) → `ansible:nginxRemove` ⚡ · Cancel → `ansible:cancel`

### Nginx (5 tabs)
- Sites: edit/delete (confirm → `nginx:removeSite`), validate-and-apply → `nginx:saveSite` ⚡nginx:log
- Config: load → `nginx:readConfig`, save → `nginx:saveConfig` ⚡, test-and-reload → `nginx:reload` ⚡
- Live status (poll 15s) → `nginx:liveStatus` · Logs (live tail 3s, export) → `nginx:logs`
- Backups: compare → `nginx:readBackupConfig`; restore (confirm) → `nginx:restore` ⚡

### Firewall
- Load rules → `firewall:get` (+ history from `activity:list`)
- Template presets (SSH/HTTP/HTTPS/Docker/K8s/DBs), rule editor, security warnings
- Apply (confirm) → `firewall:update` · Prepare rollback from history snapshot

### SSL & Domains
- Load certs → `ssl:list` · Verify DNS (auto-poll 5s/5min) → `ssl:verifyDns`
- Issue (confirm; gated on DNS match) → `ssl:issue` ⚡ssl:log
- Export PEM/CRT/KEY/ZIP (KEY confirmed) → `ssl:export`

### Cloudflare (9 tabs, 1827-line page)
- Test → `cloudflare:test` · Dashboard/Zones/create/delete zone
- DNS: wizard (`ensureDns`), record CRUD, batch proxy/TTL/delete, copy JSON
- SSL & Cache: setting patches (confirm), purge cache (confirm)
- Security / Analytics / Page Rules / Redirect Rules / Platform (Workers·R2·Access)

### Jenkins Pipelines
- New/edit pipeline form (SCM vs inline, params, env, domain block) → `jenkins:save`
- Test → `jenkins:test` · Trigger with params → `jenkins:trigger` · Status (poll 15s) → `jenkins:status`
- Delete (confirm) → `jenkins:delete`

### SSH Terminal
- Connect → `terminal:open` (+ `terminal:write`/`resize` live) · Disconnect → `terminal:close`
- xterm fed by `terminal:data` / `terminal:closed`

### Templates
- Apply infra template → `infra:applyTemplate` (navigates to /infrastructure)
- Apply/delete custom template → `infra:applyCustomTemplate` / `infra:deleteTemplate`
- Deployment templates → navigate to /deployments

### Marketplace / Updates / Settings / Logs / About / Documentation
- Plugins: install/enable/uninstall → `plugins:*`
- Updates: check/download/install → `updates:*` (+ live `updates:state`)
- Settings tabs → `settings:update`; Security tab: backup/restore → `backup:create`/`backup:restore`
- Logs: activity export, app-log tail/open-folder → `logs:*`
- About: external links → `app:openExternal`; copy diagnostics → `app:copyDiagnostics`
- Documentation: offline catalog, no IPC

## Channels with no dedicated UI button (already invokable)
`app:ping`, `app:synchronize`, `projects:get`, `projects:count`, `deploy:count`,
`cloudflare:verifyDns`, `infra:validate` (client-side today), `ansible:bootstrap` (folded into repair).

## Notes for Automation Studio UI
- Every page follows the pattern: `use*.ts` hook (React Query) + presentational components from
  `@cloudforge/ui` + `PageHeader` + confirmation provider. A workflow editor page should do the same.
- The streaming pattern (streamId + LogTerminal + subscribe) is directly reusable for a workflow
  execution log pane; structured `EngineEvent.progress` shows how to do per-node progress bars.
- The command palette and sidebar `NAVIGATION` are single-source and trivially extensible with an
  "Automation" section.
