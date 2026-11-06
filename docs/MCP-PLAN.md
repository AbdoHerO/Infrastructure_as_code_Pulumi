# CloudForge MCP Server — Full Plan

Status: **implemented**, with the defaults in section 10. [MCP.md](MCP.md) is the guide
to what shipped; this is the plan it was built from. The tool count below is the plan's;
the build has 231, because `mcp_get_permissions` was added so a client can explain a
missing tool.
Analysed version: `0.4.4` + unreleased Docker Stacks work (commit `ab58fdb`), 2026-11-04.

This plan shows how every feature of CloudForge becomes reachable through the
Model Context Protocol (MCP), so that an AI client (Claude Code, Claude Desktop or
another MCP client) can drive the application the same way you do in the UI.

---

## 0. Summary in numbers

| What was inventoried                                    | Count | Where it goes in MCP                                                         |
| ------------------------------------------------------- | ----: | ---------------------------------------------------------------------------- |
| IPC request channels (the app's API: `contract.ts`)     |   195 | 194 become tools (some split in two to four tools); 1 excluded with a reason |
| IPC event channels (push from main to UI)               |    13 | Operation logs, terminal buffers, resource updates                           |
| Background jobs (timers, unlock hooks, startup tasks)   |     9 | Status tool + "run now" tools                                                |
| Native dialogs inside handlers (file/folder pickers)    |     6 | Path-based options added to the same channels                                |
| New channels / tools for capabilities with no API today |    16 | Marked **new** in §4 (renew SSL now, withdraw DNS, get target…)              |
| Features that exist **only in the UI** (renderer logic) |   40+ | Moved to `core` and exposed (or listed as cosmetic)                          |
| Safety checks that exist **only in the UI**             |     7 | Moved to the main process **before** MCP is enabled                          |
| Pre-existing bugs found while reading (not MCP)         |    30 | Appendix B — listed, not fixed without your approval                         |
| **Total MCP tools proposed**                            |   230 | Grouped into 23 toolsets you can switch on and off                           |

How the inventory was made: every IPC handler (25 files), the IPC registry,
preload, the composition root (`container.ts`), the update manager and logger
were read in full; every renderer page and component (≈16 000 lines) was read
line by line; every application service, port and adapter in `packages/*` was
checked for methods that no handler can reach. Each table row in sections 4–7
points to a real channel or a real piece of code.

---

## 1. Principles

1. **One API, two front doors.** The IPC contract stays the single source of
   truth. The UI and MCP call **the same handler** through the same registry,
   with the same project boundary, the same operation leases and the same
   error envelope. No feature logic is duplicated for MCP.
2. **Nothing can be added without an MCP decision.** A compile-time table
   `Record<IpcChannel, McpBinding | McpExclusion>` fails the build when someone
   adds a channel and forgets to decide its MCP tool. A test checks that every
   tool points at a real channel and that every event channel is handled.
3. **The server enforces safety, not the UI.** Anything the UI currently guards
   only in React (plan validation, destructive confirmation, pinned fingerprints,
   typed names) moves into the main process first, so an AI client gets exactly
   the same protection as a person clicking.
4. **Secrets do not travel to the AI unless you allow it.** Tools that return a
   secret are off by default. Wherever a secret can go straight from your disk
   into CloudForge (env file, private key, compose `.env`), a `path` option is
   offered so it never passes through the model.
5. **You stay in control.** Critical actions (delete, destroy, terminate,
   grant access, restore, install update…) open an approval dialog **inside
   CloudForge**; the AI cannot approve its own request.

---

## 2. Architecture

### 2.1 Where the MCP server runs

Inside the **Electron main process**. Only the main process holds the unlocked
project session, the OS-keychain cipher (`safeStorage`), the operation registry,
the Pulumi engine and the SSH adapters. A separate headless process could not
decrypt secrets and would race the SQLite database and the Pulumi state files.
Consequence: MCP works **while CloudForge is open**, on the project that is open.

### 2.2 Transport

| Transport                      | For                                   | Details                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streamable HTTP on `127.0.0.1` | Claude Code, any HTTP-capable client  | Default port `47821` (configurable). Path `/mcp`. Bound to loopback only. `Host`/`Origin` checked (DNS-rebinding protection). Bearer token required (256-bit random, stored encrypted, compared in constant time, regenerate in one click). |
| stdio bridge `cloudforge-mcp`  | Claude Desktop and stdio-only clients | Small script shipped in the installer. It is started by the client, runs with CloudForge's own executable (`ELECTRON_RUN_AS_NODE=1`, so no Node.js install is needed) and forwards to the local HTTP endpoint with the token.               |

The server is **off by default** and turned on in **Settings → MCP**.

Library: `@modelcontextprotocol/sdk` (TypeScript, v1 line, pinned exactly to a
release at least two weeks old — today that is `1.32.1`). The audit flagged zod 3, so
the app moved to zod 4, which this SDK also accepts. The release
checks (`format:check`, `lint`, `typecheck`, `test`, `pnpm audit --prod
--audit-level high`) must stay green after adding it.

### 2.3 One dispatch path (refactor of `main/ipc/registry.ts`)

Today `registerHandler` calls `ipcMain.handle` directly. It becomes:

```
registerHandler(channel, handler)  →  handlers.set(channel, handler)
                                      ipcMain.handle(channel, (e, p) => dispatch(channel, p, { origin: 'renderer' }))
dispatch(channel, payload, origin) →  enforceProjectBoundary → lease → handler → IpcResult  (unchanged logic)
```

MCP calls `dispatch(channel, payload, { origin: 'mcp', client, mcpSessionId })`.
The handlers' second argument (`IpcMainInvokeEvent`) is unused today, so no
handler needs to change for this.

### 2.4 Files

```
apps/desktop/src/main/mcp/
  server.ts            HTTP listener, MCP sessions, auth, host/origin checks
  auth.ts              token create/verify/rotate (encrypted at rest)
  coverage.ts          Record<IpcChannel, binding | exclusion>  ← compile-time guard
  catalog/*.ts         one file per module: tool name, title, description, zod input,
                       output shape, annotations, tier, channel, payload adapter
  operations.ts        long-running operation manager (§2.6)
  approvals.ts         in-app approval queue (§2.9)
  session.ts           per-MCP-session state: client info, pinned project (§2.7)
  redaction.ts         masks secrets in approval text, audit and logs
  resources.ts         MCP resources + subscriptions (§2.10)
  prompts.ts           guided workflows (§2.10)
  events.ts            in-process bus fed by emitEvent (so MCP sees *:log etc.)
apps/desktop/resources/mcp/cloudforge-mcp.cjs   stdio bridge
apps/desktop/src/renderer/src/features/mcp/      Settings → MCP page, approval dialog
```

Tool input schemas are written in zod; a type-level test proves
`z.infer<schema>` is assignable to `IpcRequest<channel>` (after the adapter), so
a contract change breaks the build instead of breaking MCP silently.

### 2.5 Naming and annotations

- Tool names: `snake_case`, `<module>_<action>` (e.g. `cloudflare_create_dns_record`),
  ≤ 64 characters, letters/digits/underscore only (works in every client).
- Every tool sets MCP annotations: `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint` (true when it talks to a server or cloud).
- `projectId`, `streamId` and terminal `sessionId` are **never** asked from the
  AI: the adapter fills them from the pinned project and generates the ids.
- Errors: an `AppError` becomes a tool result with `isError: true`, its `code`
  and message — never a protocol error — so the AI can read and react to it.

### 2.6 Long-running operations (27 streaming channels)

Channels that take a `streamId` and push `*:log` events: `infra:preview`,
`infra:apply`, `infra:destroy`, `infra:refresh`, `infra:destroyStack`,
`deploy:run`, `ansible:repair`, `ansible:bootstrap`, `ansible:run`,
`ansible:jenkinsAction`, `ansible:nginxUpsert`, `ansible:nginxRemove`,
`nginx:saveSite`, `nginx:removeSite`, `nginx:saveConfig`, `nginx:reload`,
`nginx:restore`, `ssl:issue`, `runtime:apply`, `wordpress:create|redeploy|update|remove`,
`stacks:create|update|redeploy|remove`. Also slow without a stream:
`cloudflare:ensureDns` (waits up to 5 min for propagation), `backup:*`,
`ansible:preflight`, `jenkins:save`.

The operation manager:

1. generates the `streamId`, registers an operation (`id`, tool, start time,
   status, ring buffer of the last 2 000 log lines, result or error);
2. listens to the matching `*:log` events on the in-process bus;
3. sends MCP progress notifications (`notifications/progress`) when the client
   asked for them;
4. waits up to `waitSeconds` (default 45, max 300). If finished → returns the
   result + the last 200 log lines. If not → returns `{ operationId, status:
'running', logTail }`;
5. keeps finished operations for 1 hour (max 50).

MCP-only tools: `operations_list`, `operations_get`, `operations_wait`,
`operations_logs` (cursor-based), `operations_cancel`. Cancel is honest:
`deploy:run` and every `ansible:*` operation are abortable today; Pulumi,
Nginx, SSL, WordPress, stacks and runtime operations are not, and the tool
says so instead of pretending.

### 2.7 Project session and pinning

- MCP works on the project **open in the CloudForge window**. If no project is
  open, only the 16 no-session channels work (app info, project picker/create,
  import, updates…) and every other tool answers "Open and unlock a project in
  CloudForge first".
- **Pinning (new safety):** each MCP session remembers the project that was open
  at its first project-scoped call. If you switch project in the UI, that
  session's tools refuse with "The open project changed from A to B" until the
  AI calls `projects_get_session`, which re-pins and reports the new project.
  This prevents an agent halfway through a workflow from applying changes to a
  different project.
- `projects_unlock` / switching through MCP is **off by default**: it requires
  sending the passkey through the AI.

### 2.8 Keeping the UI in sync

The UI caches data (TanStack Query). When an AI changes something, the open
page must refresh:

- New event `app:dataChanged { channel, origin: 'mcp' }` emitted after every
  successful non-read MCP call. A single map in the renderer
  (`lib/mcp-sync.ts`) turns a channel prefix into the query keys to invalidate
  (`credentials:*` → `['credentials']`, `stacks:*` → stacks list, …).
- New event `projects:sessionChanged` so the window follows a lock/unlock done
  through MCP (`WorkspaceContext` refreshes the session and clears the cache).
- Titlebar badge "MCP · n clients" while a client is connected.
- MCP-started operations also stream into the existing pages' log panels.

### 2.9 Security model

**Tiers** (each tool has exactly one; set per tier in Settings → MCP):

| Tier           | Meaning                                                                                          | Default                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **R** Read     | Reads only; changes nothing (may refresh CloudForge's own cache)                                 | On                                                           |
| **W** Write    | Changes CloudForge data, a server or a cloud account; additive or reversible                     | On                                                           |
| **C** Critical | Deletes, destroys, terminates, causes downtime, costs money, grants access, restores or restarts | **Ask me each time** (in-app dialog)                         |
| **S** Secret   | Returns a secret value (password, private key, token, `.env`) to the AI                          | **Off**                                                      |
| **X** Shell    | Runs arbitrary commands on a server (terminal)                                                   | **Off**                                                      |
| **L** Local    | Touches this PC: file paths, clipboard, browser, folders                                         | On (paths only to existing folders; never overwrites a file) |

Rules:

- **Approval dialog** (tier C): shows the client name, the tool, the target and
  a readable summary of the arguments (secrets masked), with Approve / Deny.
  Timeout 2 minutes → denied. The existing settings `deployment.confirmDestructive`
  and `cloudflare.confirmDelete` ("Always enabled") are honoured.
- **The AI cannot change its own permissions.** MCP settings live in
  device-level settings, are not part of `settings:update`, and the
  `mcp:*` channels that manage them are excluded from MCP.
- **Secrets in inputs** (passkeys, `credentials_create` values, imported private
  keys) do pass through the AI provider. The plan offers path-based options
  wherever a file exists, and documents this clearly in Settings → MCP.
- **Audit:** every MCP call is logged (channel, duration, outcome; never the
  payload, same as IPC today). Every non-read call is also recorded in the
  activity feed as `mcp.tool.called` with `{ client, tool, outcome }`.
- **Toolsets:** each module (Cloudflare, Nginx, …) can be switched off; disabled
  tools are removed from the list (`notifications/tools/list_changed`), which
  also keeps the AI's context small (230 tools is a lot for some clients).

### 2.10 Resources and prompts

**Resources** (read-only context the AI can attach; `resources/updated` sent when the
matching event fires):

| URI                                                                                                                                          | Content                               | Updated by                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------- |
| `cloudforge://app/info`                                                                                                                      | version, build, platform              | —                         |
| `cloudforge://app/updates`                                                                                                                   | update state                          | `updates:state`           |
| `cloudforge://project/current`                                                                                                               | open project + summary counts         | `projects:sessionChanged` |
| `cloudforge://projects`                                                                                                                      | project picker list                   | create/delete/import      |
| `cloudforge://targets`, `cloudforge://targets/{id}`                                                                                          | saved VPS targets                     | `vpsTargets:changed`      |
| `cloudforge://cloudflare/changes`                                                                                                            | last Cloudflare sync result           | `cloudflare:changed`      |
| `cloudforge://activity`                                                                                                                      | last 100 activity events              | any write                 |
| `cloudforge://logs/app`                                                                                                                      | last 400 log lines                    | —                         |
| `cloudforge://settings`                                                                                                                      | settings                              | `settings:update`         |
| `cloudforge://catalog/{ansible-profiles, deployment-templates, infra-templates, resource-presets, dns-templates, credential-kinds, plugins}` | built-in catalogues                   | —                         |
| `cloudforge://docs/{id}`                                                                                                                     | the 25 bundled documentation articles | —                         |
| `cloudforge://operations/{id}/log`                                                                                                           | live operation log                    | operation events          |

**Prompts** (guided workflows that reproduce the multi-step flows the UI
orchestrates, with the right order, tokens and checks):

1. `onboard-vps` — inspect host key → save target → preflight → repair
2. `install-service` — choose profile → preflight → run → read access
3. `provision-infrastructure` — template → plan → validate → preview → apply → outputs → targets
4. `deploy-docker-stack` — analyze → check domains → create → status
5. `deploy-wordpress` — check domain → create → save admin login
6. `publish-domain-https` — Cloudflare ensure DNS → Nginx site → verify DNS → issue certificate
7. `issue-ssl-certificate`
8. `review-firewall` — cloud security list + VPS firewall + connectivity verdicts
9. `runtime-drift-and-apply` — inspect → drift → adopt/release → preview → apply
10. `jenkins-pipeline` — test → save → run → status
11. `give-ssh-access` — inspect → grant → send instructions
12. `diagnose-site-down` — Nginx status/logs, containers, DNS, certificate
13. `backup-project`

---

## 3. Safety checks to move server-side first (prerequisites)

These exist **only in the renderer** today. An MCP client would bypass them, so
they are fixed in the main process before any tool is enabled. The UI keeps its
own checks.

| #   | Today (UI only)                                                                                                                                                                                                    | Change in the main process                                                                                                                                      | Where                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| P1  | Ansible channels (20) take host + port + user + credential + **fingerprint** from the caller, which defeats host-key pinning (the contract comment at `contract.ts:851-857` already calls this out for Containers) | Optional `targetId` on `SshTargetRequest`; when present, everything is loaded from the saved target and caller values are ignored. MCP always sends `targetId`. | `handlers/ansible.handlers.ts`, `handlers/ssh-target.ts` |
| P2  | `deploy:run` same issue                                                                                                                                                                                            | Same `targetId` option; a manual host is accepted only with a fingerprint this MCP session obtained from `deploy_inspect_host_key`                              | `handlers/deploy.handlers.ts`                            |
| P3  | Infrastructure plan validation (`validatePlan`) runs only in the UI; `infra:savePlan`, `infra:preview` and `infra:apply` never validate                                                                            | `apply` refuses a plan with issues; `savePlan` returns issues                                                                                                   | `infrastructure-service.ts:86, 183`                      |
| P4  | Destructive-change confirmation before `infra:apply` is UI-only                                                                                                                                                    | `apply` requires `acceptDestructiveChanges: true` when the approved preview had deletes or replacements                                                         | `infrastructure-service.ts:183`                          |
| P5  | Typing the instance name before **Terminate** is UI-only                                                                                                                                                           | Optional `confirmationName` on `providers:terminateInstance`; required for MCP                                                                                  | `handlers/providers.handlers.ts:38`                      |
| P6  | Template apply silently overwrites the saved plan                                                                                                                                                                  | `replaceExistingPlan: true` required when a plan exists (MCP); UI unchanged                                                                                     | `handlers/infra.handlers.ts:128, 159`                    |
| P7  | Background Cloudflare sync is registered **non-abortable**, so Lock/Switch fails with "Wait for the active operation" while it runs (the same bug was already fixed for the SSL timer)                             | Register it abortable, like the SSL sweep                                                                                                                       | `container.ts:663-667`                                   |

---

## 4. Complete tool catalogue — every IPC channel

Legend — **Tier**: R/W/C/S/X/L as in §2.9 · **⏱** runs as an operation with a
live log (§2.6) · **Adapted** = the MCP adapter or the channel gets a small change.

### 4.1 Application (6 channels → 6 tools)

| Tool                    | Channel               | Tier | Notes                                                                                       |
| ----------------------- | --------------------- | ---- | ------------------------------------------------------------------------------------------- |
| `app_get_info`          | `app:getInfo`         | R    |                                                                                             |
| `app_ping`              | `app:ping`            | R    | Health check (unused by the UI today)                                                       |
| `app_open_link`         | `app:openExternal`    | L    | Only the two product links: `github`, `releases`                                            |
| `app_get_diagnostics`   | `app:copyDiagnostics` | R    | **Adapted:** returns the diagnostics text; option `copyToClipboard` keeps the old behaviour |
| `app_copy_to_clipboard` | `app:copyText`        | L    |                                                                                             |
| `app_synchronize`       | `app:synchronize`     | W    | Reconciles managed VPS targets + Cloudflare sync; returns warnings                          |

### 4.2 Projects / workspaces (13 → 13)

| Tool                      | Channel                  | Tier | Notes                                                                                               |
| ------------------------- | ------------------------ | ---- | --------------------------------------------------------------------------------------------------- |
| `projects_list`           | `projects:picker`        | R    | All projects with summaries (targets, pipelines, deployments); no open project needed               |
| `projects_list_open`      | `projects:list`          | R    | The open project                                                                                    |
| `projects_get`            | `projects:get`           | R    | Unused by the UI today                                                                              |
| `projects_count`          | `projects:count`         | R    | Unused by the UI today                                                                              |
| `projects_get_session`    | `projects:session`       | R    | Also re-pins the MCP session (§2.7)                                                                 |
| `projects_create`         | `projects:create`        | W    | Passkey ≥ 8. Default region taken from `settings.deployment.defaultRegion` (today ignored, see B-2) |
| `projects_unlock`         | `projects:unlock`        | W    | Only if "Allow MCP to open and switch projects" is on                                               |
| `projects_lock`           | `projects:lock`          | W    | Closes all SSH terminals; refused while a non-cancellable operation runs                            |
| `projects_duplicate`      | `projects:duplicate`     | W    |                                                                                                     |
| `projects_update`         | `projects:update`        | W    | Name, region, environment, description, icon, colour, linked provider                               |
| `projects_change_passkey` | `projects:changePasskey` | C    |                                                                                                     |
| `projects_remove_passkey` | `projects:removePasskey` | C    | Exact project name required                                                                         |
| `projects_delete`         | `projects:delete`        | C    | Exact name + passkey; refused while cloud resources exist                                           |

### 4.3 Credentials and secret storage (7 → 7 + 1 new)

| Tool                                  | Channel                             | Tier | Notes                                                                                                                          |
| ------------------------------------- | ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `credentials_list`                    | `credentials:list`                  | R    | Names and kinds only, never values                                                                                             |
| `credentials_list_kinds`              | **new** (core `CREDENTIAL_SCHEMAS`) | R    | The 14 kinds and their fields, so the AI sends the right data                                                                  |
| `credentials_create`                  | `credentials:create`                | W    | Secret values pass through the AI                                                                                              |
| `credentials_update`                  | `credentials:update`                | W    | **Adapted:** partial update — omitted fields keep their stored value (the UI reveals everything to edit; MCP must not need to) |
| `credentials_import_environment_file` | `credentials:importEnvironmentFile` | W+L  | **Adapted:** `path` + `name`; main reads the file (same 1 MB/text checks) and creates the credential; content never returned   |
| `credentials_reveal`                  | `credentials:reveal`                | S    |                                                                                                                                |
| `credentials_delete`                  | `credentials:delete`                | C    |                                                                                                                                |
| `security_get_status`                 | `security:status`                   | R    | OS keychain or local key                                                                                                       |

### 4.4 Settings (2 → 2)

| Tool              | Channel           | Tier | Notes                                                                                                              |
| ----------------- | ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| `settings_get`    | `settings:get`    | R    |                                                                                                                    |
| `settings_update` | `settings:update` | W    | All 25 fields (appearance, deployment, logs, updates, SSL, Cloudflare). MCP permissions are **not** reachable here |

### 4.5 Backup and portability (3 → 3)

| Tool                     | Channel                | Tier | Notes                                                                                           |
| ------------------------ | ---------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `backup_create_project`  | `backup:create`        | W+L  | **Adapted:** `destinationDir` instead of the folder dialog; passphrase ≥ 12 + current passkey   |
| `backup_restore_project` | `backup:restore`       | C+L  | `sourceDir`; CloudForge **restarts**, so the MCP connection drops and the client must reconnect |
| `backup_import_project`  | `backup:importProject` | W+L  | `sourceDir`; works with no open project; restarts                                               |

### 4.6 SSH keys (7 → 7)

| Tool                           | Channel                      | Tier | Notes                                                                                                                           |
| ------------------------------ | ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ssh_keys_list`                | `sshKeys:list`               | R    | Public key + fingerprint                                                                                                        |
| `ssh_keys_generate`            | `sshKeys:generate`           | W    | ed25519 or RSA 3072, optional passphrase                                                                                        |
| `ssh_keys_import`              | `sshKeys:import`             | W    | **Adapted:** `privateKey` **or** `privateKeyPath` (keeps the key out of the AI)                                                 |
| `ssh_keys_reveal_private`      | `sshKeys:revealPrivate`      | S    |                                                                                                                                 |
| `ssh_keys_export_private`      | `sshKeys:exportPrivate`      | S+L  | **Adapted:** `path` instead of the save dialog; never overwrites; owner-only permissions                                        |
| `ssh_keys_materialize_private` | `sshKeys:materializePrivate` | S    | Writes the key into the project's temporary key folder (deleted on lock) and returns the path — lets a local agent run `ssh -i` |
| `ssh_keys_delete`              | `sshKeys:delete`             | C    |                                                                                                                                 |

### 4.7 Cloud providers and cloud firewall (11 → 13 + 2 new)

| Tool                                  | Channel                               | Tier | Notes                                                                                                                              |
| ------------------------------------- | ------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `providers_test_connection`           | `providers:test`                      | R    |                                                                                                                                    |
| `providers_list_regions`              | `providers:listRegions`               | R    |                                                                                                                                    |
| `providers_list_shapes`               | `providers:listShapes`                | R    |                                                                                                                                    |
| `providers_list_images`               | `providers:listImages`                | R    | AWS only (OCI answers "not supported")                                                                                             |
| `providers_list_availability_domains` | `providers:listAvailabilityDomains`   | R    |                                                                                                                                    |
| `providers_list_instances`            | `providers:listInstances`             | R    |                                                                                                                                    |
| `providers_list_resources`            | `providers:listResources`             | R    |                                                                                                                                    |
| `providers_start_instance`            | `providers:instanceAction` (`start`)  | W    | One channel split in three tools so each gets the right tier                                                                       |
| `providers_stop_instance`             | `providers:instanceAction` (`stop`)   | C    |                                                                                                                                    |
| `providers_reboot_instance`           | `providers:instanceAction` (`reboot`) | C    |                                                                                                                                    |
| `providers_terminate_instance`        | `providers:terminateInstance`         | C    | Exact instance name (P5)                                                                                                           |
| `cloud_firewall_get`                  | `firewall:get`                        | R    | OCI only (AWS has no firewall support, B-26)                                                                                       |
| `cloud_firewall_update`               | `firewall:update`                     | C    | `expectedRules` from the last get (concurrency token); returns warnings                                                            |
| `cloud_firewall_analyze`              | **new**                               | R    | Warnings (duplicates, SSH/all open to the world, stateless, overlaps) + quick-rule presets — moved from `FirewallPage.tsx` to core |
| `cloud_firewall_history`              | **new** (filtered `activity:list`)    | R    | Past changes with before/after snapshots; rollback = `cloud_firewall_update` with a snapshot                                       |

### 4.8 Infrastructure (Pulumi) and templates (17 → 17 + 3 new)

| Tool                           | Channel                       | Tier | Notes                                                                                                                                             |
| ------------------------------ | ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra_engine_status`          | `infra:engineStatus`          | R    | Pulumi CLI available?                                                                                                                             |
| `infra_get_plan`               | `infra:getPlan`               | R    |                                                                                                                                                   |
| `infra_save_plan`              | `infra:savePlan`              | W    | Returns validation issues (P3)                                                                                                                    |
| `infra_validate_plan`          | `infra:validate`              | R    | Unused by the UI today                                                                                                                            |
| `infra_preview`                | `infra:preview`               | R ⏱  | Returns `previewToken` + the destructive changes                                                                                                  |
| `infra_apply`                  | `infra:apply`                 | C ⏱  | Needs `previewToken`; refuses invalid plans (P3); `acceptDestructiveChanges` (P4)                                                                 |
| `infra_destroy`                | `infra:destroy`               | C ⏱  | Also deletes the saved plan and managed targets                                                                                                   |
| `infra_refresh`                | `infra:refresh`               | W ⏱  | Drift detection                                                                                                                                   |
| `infra_get_outputs`            | `infra:outputs`               | R    | Re-syncs managed VPS targets                                                                                                                      |
| `infra_list_managed_stacks`    | `infra:managedStacks`         | R    |                                                                                                                                                   |
| `infra_destroy_stack`          | `infra:destroyStack`          | C ⏱  |                                                                                                                                                   |
| `infra_list_templates`         | `infra:templates`             | R    | 6 built-in templates                                                                                                                              |
| `infra_apply_template`         | `infra:applyTemplate`         | W    | Adds `region` and **`shape`** (the template accepts a shape but IPC never passed it); P6 overwrite guard                                          |
| `infra_list_custom_templates`  | `infra:customTemplates`       | R    |                                                                                                                                                   |
| `infra_save_custom_template`   | `infra:saveTemplate`          | W    |                                                                                                                                                   |
| `infra_delete_custom_template` | `infra:deleteTemplate`        | C    |                                                                                                                                                   |
| `infra_apply_custom_template`  | `infra:applyCustomTemplate`   | W    | P6 overwrite guard                                                                                                                                |
| `infra_get_custom_template`    | **new** (`TemplateStore.get`) | R    | Read a saved template's plan (no channel today)                                                                                                   |
| `infra_resource_presets`       | **new**                       | R    | Default network/subnet/firewall/compute/volume per provider, shape and OS-image lists — moved from `resource-templates.ts` / `ResourceEditor.tsx` |
| `infra_ssh_connections`        | **new**                       | R    | SSH hints from outputs + matched managed key + ready `ssh` command (today computed in `InfrastructurePage.tsx`)                                   |

### 4.9 Deployments (6 → 6)

| Tool                      | Channel                 | Tier | Notes                        |
| ------------------------- | ----------------------- | ---- | ---------------------------- |
| `deploy_list_templates`   | `deploy:templates`      | R    | 6 templates                  |
| `deploy_list`             | `deploy:list`           | R    | History                      |
| `deploy_count`            | `deploy:count`          | R    | Unused by the UI today       |
| `deploy_inspect_host_key` | `deploy:inspectHostKey` | R    |                              |
| `deploy_run`              | `deploy:run`            | W ⏱  | **Adapted:** `targetId` (P2) |
| `deploy_cancel`           | `deploy:cancel`         | W    |                              |

### 4.10 VPS targets and Ansible (20 → 21 + 1 new)

All tools take a **`targetId`** (P1); the raw host/fingerprint tuple is not accepted from MCP.

| Tool                         | Channel                             | Tier | Notes                                                                          |
| ---------------------------- | ----------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `targets_list`               | `ansible:targets`                   | R    |                                                                                |
| `targets_get`                | **new** (`VpsTargetService.get`)    | R    | No channel today                                                               |
| `targets_inspect_host_key`   | `ansible:inspectHostKey`            | R    | Server remembers the fingerprint it saw for 10 minutes                         |
| `targets_create`             | `ansible:createTarget`              | W    | Fingerprint must be one this session inspected (no invented fingerprints)      |
| `targets_update`             | `ansible:updateTarget`              | W    | Same rule                                                                      |
| `targets_delete`             | `ansible:deleteTarget`              | C    | The VPS itself is not touched                                                  |
| `ansible_list_profiles`      | `ansible:profiles`                  | R    | docker, dockhand, portainer, jenkins, nginx, postgres + variable specs         |
| `ansible_get_status`         | `ansible:status`                    | R    | Unused by the UI today                                                         |
| `ansible_get_profile_states` | `ansible:profileStates`             | R    | Installed/running per profile, live configuration                              |
| `ansible_preflight`          | `ansible:preflight`                 | R    | Records readiness on the target                                                |
| `ansible_repair`             | `ansible:repair`                    | W ⏱  | Installs prerequisite packages                                                 |
| `ansible_bootstrap`          | `ansible:bootstrap`                 | W ⏱  | Unused by the UI today                                                         |
| `ansible_run_profile`        | `ansible:run`                       | W ⏱  | Missing variables filled with the profile defaults server-side (UI-only today) |
| `ansible_jenkins_verify`     | `ansible:jenkinsAction` (`verify`)  | R ⏱  |                                                                                |
| `ansible_jenkins_restart`    | `ansible:jenkinsAction` (`restart`) | W ⏱  | Jenkins briefly offline                                                        |
| `ansible_get_access`         | `ansible:access`                    | S    | Jenkins initial admin password; PostgreSQL password and connection string      |
| `ansible_cancel`             | `ansible:cancel`                    | W    |                                                                                |
| `ansible_list_networks`      | `ansible:networks`                  | R    |                                                                                |
| `ansible_create_network`     | `ansible:createNetwork`             | W    |                                                                                |
| `ansible_list_nginx_sites`   | `ansible:nginxSites`                | R    |                                                                                |
| `ansible_upsert_nginx_site`  | `ansible:nginxUpsert`               | W ⏱  |                                                                                |
| `ansible_remove_nginx_site`  | `ansible:nginxRemove`               | C ⏱  |                                                                                |

### 4.11 Containers and runtime inventory (6 → 9)

| Tool                        | Channel                         | Tier | Notes                                                   |
| --------------------------- | ------------------------------- | ---- | ------------------------------------------------------- |
| `containers_list`           | `containers:list`               | R    | Unused by the UI today                                  |
| `runtime_inspect`           | `runtime:inspect`               | R    | Containers, networks, volumes, ownership, port exposure |
| `containers_start`          | `containers:action` (`start`)   | W    |                                                         |
| `containers_restart`        | `containers:action` (`restart`) | W    |                                                         |
| `containers_stop`           | `containers:action` (`stop`)    | C    |                                                         |
| `containers_remove`         | `containers:action` (`remove`)  | C    |                                                         |
| `containers_logs`           | `containers:logs`               | R    | `lines` exposed (UI always 200)                         |
| `containers_stats`          | `containers:stats`              | R    |                                                         |
| `containers_deploy_compose` | `containers:deployCompose`      | W    |                                                         |

### 4.12 VPS runtime plan (11 → 11)

| Tool                          | Channel                | Tier | Notes                                                                                                                           |
| ----------------------------- | ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `runtime_get_plan`            | `runtime:getPlan`      | R    |                                                                                                                                 |
| `runtime_save_plan`           | `runtime:savePlan`     | W    | Validated server-side already. Unused by the UI today                                                                           |
| `runtime_validate_plan`       | `runtime:validatePlan` | R    | Unused by the UI today                                                                                                          |
| `runtime_set_mode`            | `runtime:setMode`      | W    | legacy / hybrid / managed                                                                                                       |
| `runtime_drift`               | `runtime:drift`        | R    | SSH read                                                                                                                        |
| `runtime_adopt`               | `runtime:adopt`        | W    | Database only                                                                                                                   |
| `runtime_release`             | `runtime:release`      | W    | Database only                                                                                                                   |
| `runtime_connectivity`        | `runtime:connectivity` | R    |                                                                                                                                 |
| `runtime_open_required_ports` | `runtime:openFirewall` | W    | Additive only                                                                                                                   |
| `runtime_preview`             | `runtime:preview`      | R    | Returns token + operations; `options` exposed (never sent by the UI)                                                            |
| `runtime_apply`               | `runtime:apply`        | C ⏱  | Token + exact resource name per destructive operation; its log becomes visible (the UI never subscribes to `runtime:log`, B-12) |

### 4.13 Host firewall and SSH access for other people (6 → 6 + 1 new)

| Tool                       | Channel                | Tier | Notes                                                                                      |
| -------------------------- | ---------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `host_firewall_inspect`    | `hostFirewall:inspect` | R    | ufw / firewalld / iptables / nftables                                                      |
| `host_firewall_open`       | `hostFirewall:open`    | W    | Additive, idempotent                                                                       |
| `host_firewall_close`      | `hostFirewall:close`   | C    | The SSH port is always refused                                                             |
| `host_access_inspect`      | `hostAccess:inspect`   | R    |                                                                                            |
| `host_access_grant`        | `hostAccess:grant`     | C    | Gives a person SSH access, optionally sudo                                                 |
| `host_access_revoke`       | `hostAccess:revoke`    | C    |                                                                                            |
| `host_access_instructions` | **new**                | R    | Connection message (EN/FR) and key-request text — computed in `ServerAccessCard.tsx` today |

### 4.14 SSH terminal (4 → 4 + 2)

| Tool              | Channel                                                | Tier | Notes                                                                                                                              |
| ----------------- | ------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `terminal_open`   | `terminal:open`                                        | X    |                                                                                                                                    |
| `terminal_write`  | `terminal:write`                                       | X    |                                                                                                                                    |
| `terminal_resize` | `terminal:resize`                                      | X    |                                                                                                                                    |
| `terminal_close`  | `terminal:close`                                       | X    |                                                                                                                                    |
| `terminal_read`   | MCP-only (buffer of `terminal:data`/`terminal:closed`) | X    | Output since a cursor                                                                                                              |
| `terminal_exec`   | **new** `terminal:exec`                                | X    | Non-interactive command on a saved target: exit code, stdout/stderr (size-capped), timeout. New `exec` in the SSH terminal adapter |

### 4.15 Nginx (12 → 12 + 1 new)

| Tool                   | Channel                  | Tier | Notes                                                                                                 |
| ---------------------- | ------------------------ | ---- | ----------------------------------------------------------------------------------------------------- |
| `nginx_inspect`        | `nginx:inspect`          | R    |                                                                                                       |
| `nginx_list_sites`     | `nginx:listSites`        | R    |                                                                                                       |
| `nginx_save_site`      | `nginx:saveSite`         | W ⏱  | Structured fields (headers, locations, snippets); server stamps `lastModified` (done by the UI today) |
| `nginx_remove_site`    | `nginx:removeSite`       | C ⏱  |                                                                                                       |
| `nginx_read_config`    | `nginx:readConfig`       | R    |                                                                                                       |
| `nginx_save_config`    | `nginx:saveConfig`       | C ⏱  | Raw `nginx.conf`; validated and backed up                                                             |
| `nginx_reload`         | `nginx:reload`           | W ⏱  |                                                                                                       |
| `nginx_live_status`    | `nginx:liveStatus`       | R    |                                                                                                       |
| `nginx_read_logs`      | `nginx:logs`             | R    | `kind`, `search`, `limit`                                                                             |
| `nginx_list_backups`   | `nginx:backups`          | R    |                                                                                                       |
| `nginx_read_backup`    | `nginx:readBackupConfig` | R    |                                                                                                       |
| `nginx_restore_backup` | `nginx:restore`          | C ⏱  |                                                                                                       |
| `nginx_compare_backup` | **new**                  | R    | Backup vs current config diff (UI-only today)                                                         |

### 4.16 SSL certificates (4 → 5 + 1 new)

| Tool                     | Channel                     | Tier | Notes                                                                                                                                                                                                                  |
| ------------------------ | --------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssl_verify_dns`         | `ssl:verifyDns`             | R    |                                                                                                                                                                                                                        |
| `ssl_list_certificates`  | `ssl:list`                  | R    | Adds the summary counts the UI computes (valid / expiring ≤ 30 d / expired)                                                                                                                                            |
| `ssl_issue_certificate`  | `ssl:issue`                 | W ⏱  | **Adapted:** `waitForDnsSeconds` — the server polls DNS every 5 s (as the UI does) and refuses to issue if it doesn't match; every config field exposed (`keepCloudflareSslMode`, `httpRedirect`, all validity values) |
| `ssl_export_certificate` | `ssl:export` (`pem`, `crt`) | R    | Optional `savePath` (L)                                                                                                                                                                                                |
| `ssl_export_private_key` | `ssl:export` (`key`, `zip`) | S    | ZIP contains the private key too (B-15)                                                                                                                                                                                |
| `ssl_renew_due_now`      | **new** `ssl:renewDue`      | W    | Runs the renewal sweep now (today only a timer)                                                                                                                                                                        |

### 4.17 Cloudflare (24 → 27 + 3 new)

| Tool                              | Channel                                             | Tier | Notes                                                                                                                    |
| --------------------------------- | --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `cloudflare_test_connection`      | `cloudflare:test`                                   | R    |                                                                                                                          |
| `cloudflare_get_dashboard`        | `cloudflare:dashboard`                              | R    |                                                                                                                          |
| `cloudflare_list_zones`           | `cloudflare:zones`                                  | R    |                                                                                                                          |
| `cloudflare_create_zone`          | `cloudflare:createZone`                             | W    | `accountId` exposed (never sent by the UI)                                                                               |
| `cloudflare_delete_zone`          | `cloudflare:deleteZone`                             | C    |                                                                                                                          |
| `cloudflare_list_dns_records`     | `cloudflare:dnsRecords`                             | R    |                                                                                                                          |
| `cloudflare_create_dns_record`    | `cloudflare:createDnsRecord`                        | W    |                                                                                                                          |
| `cloudflare_update_dns_record`    | `cloudflare:updateDnsRecord`                        | W    |                                                                                                                          |
| `cloudflare_delete_dns_record`    | `cloudflare:deleteDnsRecord`                        | C    |                                                                                                                          |
| `cloudflare_batch_set_proxy`      | `cloudflare:batchDnsRecords` (`proxy`)              | W    | One channel split in four tools                                                                                          |
| `cloudflare_batch_set_ttl`        | `cloudflare:batchDnsRecords` (`ttl`)                | W    |                                                                                                                          |
| `cloudflare_batch_repoint`        | `cloudflare:batchDnsRecords` (`address`)            | C    | A/AAAA inferred from the address server-side (UI-only today)                                                             |
| `cloudflare_batch_delete`         | `cloudflare:batchDnsRecords` (`delete`)             | C    |                                                                                                                          |
| `cloudflare_ensure_dns`           | `cloudflare:ensureDns`                              | W ⏱  | Create/update + wait for propagation                                                                                     |
| `cloudflare_verify_dns`           | `cloudflare:verifyDns`                              | R    | Unused by the UI today                                                                                                   |
| `cloudflare_get_zone_settings`    | `cloudflare:zoneSettings`                           | R    |                                                                                                                          |
| `cloudflare_update_zone_settings` | `cloudflare:updateZoneSettings`                     | W    | All fields, including security level, browser integrity, cache level and browser TTL (not editable in the UI)            |
| `cloudflare_purge_cache`          | `cloudflare:purgeCache`                             | C    |                                                                                                                          |
| `cloudflare_get_security`         | `cloudflare:security`                               | R    |                                                                                                                          |
| `cloudflare_get_analytics`        | `cloudflare:analytics`                              | R    | **Adapted:** `range` (`today`, `yesterday`, `7d`, `30d`) computed server-side, or explicit `since`/`until`               |
| `cloudflare_list_page_rules`      | `cloudflare:pageRules`                              | R    |                                                                                                                          |
| `cloudflare_save_page_rule`       | `cloudflare:savePageRule`                           | W    | Any actions/status (the UI hard-codes `always_use_https`)                                                                |
| `cloudflare_delete_page_rule`     | `cloudflare:deletePageRule`                         | C    |                                                                                                                          |
| `cloudflare_list_redirect_rules`  | `cloudflare:redirectRules`                          | R    |                                                                                                                          |
| `cloudflare_save_redirect_rule`   | `cloudflare:saveRedirectRule`                       | W    | `priority` exposed                                                                                                       |
| `cloudflare_delete_redirect_rule` | `cloudflare:deleteRedirectRule`                     | C    |                                                                                                                          |
| `cloudflare_get_platform`         | `cloudflare:platform`                               | R    | Workers, R2, Access, Gateway (read-only); `accountId` derived from the zone                                              |
| `cloudflare_list_dns_templates`   | **new**                                             | R    | The 8 presets (Laravel, Node, Next.js, WordPress, Mail, API, Subdomain, Load Balancer) — moved from `CloudflarePage.tsx` |
| `cloudflare_apply_dns_template`   | **new**                                             | W    | Creates the record a preset describes                                                                                    |
| `cloudflare_withdraw_dns`         | **new** (`CloudflareDnsAutomationService.withdraw`) | C    | Removes a record CloudForge created for a domain (today only inside WordPress/stack removal)                             |

### 4.18 Domains (1 → 1)

| Tool            | Channel         | Tier | Notes                                                             |
| --------------- | --------------- | ---- | ----------------------------------------------------------------- |
| `domains_check` | `domains:check` | R    | Is the domain free (other apps, Nginx sites, Cloudflare records)? |

### 4.19 WordPress (6 → 6)

| Tool                 | Channel              | Tier | Notes                                                                                            |
| -------------------- | -------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `wordpress_list`     | `wordpress:list`     | R    |                                                                                                  |
| `wordpress_create`   | `wordpress:create`   | W ⏱  | Admin password returned only if tier S is on; otherwise "saved in Secrets as WordPress · domain" |
| `wordpress_redeploy` | `wordpress:redeploy` | W ⏱  |                                                                                                  |
| `wordpress_update`   | `wordpress:update`   | W ⏱  | A few seconds offline                                                                            |
| `wordpress_status`   | `wordpress:status`   | R    |                                                                                                  |
| `wordpress_remove`   | `wordpress:remove`   | C ⏱  | `deleteData` true deletes every post, upload and the database                                    |

### 4.20 Docker stacks (9 → 9)

| Tool                 | Channel               | Tier | Notes                                                                                                    |
| -------------------- | --------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `stacks_list`        | `stacks:list`         | R    |                                                                                                          |
| `stacks_analyze`     | `stacks:analyze`      | R    |                                                                                                          |
| `stacks_read_folder` | `stacks:chooseFolder` | R+L  | **Adapted:** `path` instead of the dialog; returns Compose + analysis; `.env` as variable **names** only |
| `stacks_create`      | `stacks:create`       | W ⏱  | Inline files **or** `folderPath` (the `.env` goes disk → CloudForge, never through the AI)               |
| `stacks_reveal`      | `stacks:reveal`       | S    | Decrypted Compose + `.env`                                                                               |
| `stacks_update`      | `stacks:update`       | W ⏱  |                                                                                                          |
| `stacks_redeploy`    | `stacks:redeploy`     | W ⏱  |                                                                                                          |
| `stacks_status`      | `stacks:status`       | R    |                                                                                                          |
| `stacks_remove`      | `stacks:remove`       | C ⏱  | `deleteData`                                                                                             |

### 4.21 Jenkins pipelines (6 → 6)

| Tool                      | Channel           | Tier | Notes                                                                             |
| ------------------------- | ----------------- | ---- | --------------------------------------------------------------------------------- |
| `jenkins_list_pipelines`  | `jenkins:list`    | R    |                                                                                   |
| `jenkins_test_connection` | `jenkins:test`    | R    |                                                                                   |
| `jenkins_save_pipeline`   | `jenkins:save`    | W    | Environment as a map                                                              |
| `jenkins_delete_pipeline` | `jenkins:delete`  | C    |                                                                                   |
| `jenkins_trigger_build`   | `jenkins:trigger` | W    | Becomes **C** when a parameter value is `WIPE` (the UI has no confirmation, B-19) |
| `jenkins_get_status`      | `jenkins:status`  | R    |                                                                                   |

### 4.22 Activity, logs, updates, plugins (14 → 15 + 1 new)

| Tool                  | Channel              | Tier         | Notes                                                                |
| --------------------- | -------------------- | ------------ | -------------------------------------------------------------------- |
| `activity_list`       | `activity:list`      | R            | **Adapted:** filters `typePrefix`, `search`, `since` (UI-only today) |
| `logs_get_info`       | `logs:info`          | R            |                                                                      |
| `logs_tail`           | `logs:tail`          | R            |                                                                      |
| `logs_open_folder`    | `logs:openFolder`    | L            |                                                                      |
| —                     | `logs:report`        | **excluded** | See §8                                                               |
| `logs_prune`          | **new** `logs:prune` | W            | Today only at startup and on settings save                           |
| `updates_get_state`   | `updates:state`      | R            |                                                                      |
| `updates_check`       | `updates:check`      | R            |                                                                      |
| `updates_download`    | `updates:download`   | W            |                                                                      |
| `updates_install`     | `updates:install`    | C            | Restarts CloudForge                                                  |
| `plugins_list`        | `plugins:list`       | R            |                                                                      |
| `plugins_list_active` | `plugins:active`     | R            |                                                                      |
| `plugins_install`     | `plugins:install`    | W            |                                                                      |
| `plugins_set_enabled` | `plugins:setEnabled` | W            |                                                                      |
| `plugins_uninstall`   | `plugins:uninstall`  | W            |                                                                      |

### 4.23 MCP-only tools

| Tool                                                                                           | Tier  | Purpose                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| `operations_list`, `operations_get`, `operations_wait`, `operations_logs`, `operations_cancel` | R / W | Long-running operations (§2.6)                                                                                             |
| `app_background_jobs` (**new** channel `app:backgroundJobs`)                                   | R     | Last/next run of the SSL renewal sweep and Cloudflare sync, managed certificates, last deployment recovery, last log prune |
| `docs_search`, `docs_read`                                                                     | R     | The 25 bundled documentation articles                                                                                      |
| `ui_navigate`, `ui_set_theme` (new event `ui:command`)                                         | L     | Optional: open a page in the window, change the theme (stored in the browser today)                                        |

---

## 5. Events → MCP

| Event channel                                                                                                    | MCP handling                                             |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `engine:log`, `deploy:log`, `ansible:log`, `nginx:log`, `runtime:log`, `ssl:log`, `wordpress:log`, `stacks:log`  | Operation log buffer + progress notifications (§2.6)     |
| `terminal:data`, `terminal:closed`                                                                               | Per-session terminal buffer for `terminal_read`          |
| `updates:state`                                                                                                  | `cloudforge://app/updates` updated                       |
| `vpsTargets:changed`                                                                                             | `cloudforge://targets` updated                           |
| `cloudflare:changed`                                                                                             | `cloudforge://cloudflare/changes` updated                |
| **new** `app:dataChanged`, `projects:sessionChanged`, `ui:command`, `mcp:approvalRequested`, `mcp:statusChanged` | Main → UI only (keep the window in sync, show approvals) |

---

## 6. Background jobs → MCP

| Job                                     | Trigger today                                                                        | MCP                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| SSL renewal sweep                       | 60 s timer, gated by `ssl.checkIntervalHours`; forced 30 s after start and on unlock | `ssl_renew_due_now` (new) + `app_background_jobs`    |
| Cloudflare sync                         | 60 s timer, gated by `cloudflare.autoRefreshMinutes` and `autoSync`                  | `app_synchronize` + `app_background_jobs` (+ fix P7) |
| Managed VPS target reconciliation       | On unlock and Refresh                                                                | `app_synchronize`, `infra_get_outputs`               |
| Interrupted-deployment recovery         | On unlock                                                                            | Automatic; count shown in `app_background_jobs`      |
| Log pruning and rotation                | Startup, settings save, project switch                                               | `logs_prune` (new)                                   |
| Update check                            | Startup (packaged builds)                                                            | `updates_check`                                      |
| Schema migration, transient key cleanup | Startup                                                                              | Not a feature — automatic, no tool                   |
| Project activate/deactivate hooks       | Unlock/lock                                                                          | Through `projects_unlock` / `projects_lock`          |
| Per-request operation lease             | Every project IPC call                                                               | Same for MCP (shared dispatch)                       |

"Writes triggered by reads" (`jenkins:list`, `jenkins:status`, `nginx:listSites`,
`ssl:list`, `cloudflare:dnsRecords`, `infra:outputs`, `wordpress:status`,
`ansible:preflight`) only refresh CloudForge's own records; they stay tier R and
the tool descriptions mention the side effect.

---

## 7. UI-only logic → where it goes

| Today in the renderer                                                                                                                    | Becomes                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Cloudflare DNS presets (8), type rules (proxy only A/AAAA/CNAME, MX/URI priority), batch repoint A/AAAA inference, analytics date ranges | `cloudflare_list_dns_templates`, `cloudflare_apply_dns_template`, schema rules, `range` option                    |
| Cloudflare DNS search/sort/filter, Export JSON                                                                                           | Returned data; the AI filters itself; `app_copy_to_clipboard` exists                                              |
| DomainPicker: domain composition, subdomain regex, 600 ms debounce                                                                       | `domains_check` takes the full domain; the core `isValidDomain` check already runs in main                        |
| SSL: DNS poll loop (5 s, 5 min), metrics, download                                                                                       | `waitForDnsSeconds`, summary counts, `savePath`                                                                   |
| Nginx: header/line/location parsing, `lastModified`, config diff, backup compare, log export, live tail                                  | Structured input, server stamp, `nginx_compare_backup`, `nginx_read_logs` with `limit`                            |
| Ansible: default variable merge, preflight gate, live-config back-fill                                                                   | Server-side defaults; `run` already re-checks preflight; `ansible_get_profile_states`                             |
| Jenkins: form defaults, `KEY=value` parsing, parameter naming, managed parameters                                                        | Schema defaults; the map is passed directly                                                                       |
| Stacks: name slug, blockers, route defaults, single-service auto-fill                                                                    | Schema defaults + existing server validation (main re-validates on create)                                        |
| WordPress: client validation, suggested port, compose-name preview                                                                       | Already validated in main (`validateWordPressSite`); port chosen by main                                          |
| Infrastructure: resource presets, shape/image lists, plan validation, preview↔plan binding, SSH command                                  | `infra_resource_presets`, P3/P4, `infra_ssh_connections` (the preview token is already bound to the plan in main) |
| Firewall: quick presets, warnings, history, rollback, reachability matrix                                                                | `cloud_firewall_analyze`, `cloud_firewall_history`, `runtime_connectivity`                                        |
| Host access: username/public-key validation, instructions EN/FR                                                                          | Validation already in main (`grant`); `host_access_instructions`                                                  |
| VPS runtime: type-to-confirm per destructive op                                                                                          | Already enforced in main (`confirmations`)                                                                        |
| Activity search/category filter/export                                                                                                   | `activity_list` filters                                                                                           |
| Credential schemas (fields per kind)                                                                                                     | `credentials_list_kinds`                                                                                          |
| Theme (localStorage), navigation, command palette (navigation only), Ctrl+K                                                              | `ui_set_theme`, `ui_navigate` (optional toolset)                                                                  |
| Documentation catalogue (25 articles, search)                                                                                            | `docs_search`, `docs_read`, `cloudforge://docs/{id}`                                                              |
| Dashboard cards (hard-coded)                                                                                                             | `projects_list` summaries already carry real counts                                                               |
| Badge colours, animations, relative times, masking toggles                                                                               | Cosmetic — no MCP equivalent needed                                                                               |

---

## 8. Exclusions (each with its reason)

| Item                                                                                                                                                                                                                                                                                                                                                                                                                               | Reason                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `logs:report`                                                                                                                                                                                                                                                                                                                                                                                                                      | The renderer's own error forwarding (window errors, `console.error`). Not a feature; every MCP call is already logged by the MCP layer                                         |
| New `mcp:*` channels (settings, token, approvals, client list)                                                                                                                                                                                                                                                                                                                                                                     | An AI must never change its own permissions or approve its own requests                                                                                                        |
| Internal building blocks: `getDecrypted`, `resolveAuthentication`, `recordSafe`, `upsertManaged`, `removeManaged*`, runtime topology syncs (`upsertApplication`, `replaceRoutes`, `replaceCertificates`, `upsertDnsRecord`, …), Origin CA `create/prepare/install/discard`, `enableStrictSslForDomain`, `findByPublicKey`, `recoverInterrupted`, `closeAll`, project context `activate/clear`, `DomainPublisher.publish/unpublish` | Steps inside existing features, reachable through those features. Exposing them alone would skip the checks around them (domain ownership, certificate tracking, runtime sync) |
| Dead code: `exportPortableSecrets`, `importPortableSecrets`, `ProjectService.list`, `removeManagedOutsideProjects`, `RuntimePlanService.upsertRoute/removeRoute/delete`, `ProviderFactory.supports`, `snapshotDatabase`, `dispose`, `CreateProjectForm`, `useCreateProject`, `PlaceholderPage`                                                                                                                                     | Not reachable by anyone today; removal can be proposed separately                                                                                                              |
| Build and release scripts: `scripts/set-release-version.mjs`, `apps/desktop/scripts/stage-packaged-runtime.cjs`, `verify-packaged-runtime.cjs`, CI workflows, empty `tools/deploy-app` and `tools/provision-app`                                                                                                                                                                                                                   | Developer tooling, not part of the running application                                                                                                                         |
| Server-side scripts generated by the app (Ansible playbooks, deployment template steps, `wordpress-script`, `stack-script`, `vps-preflight`, Nginx/host firewall/host access scripts)                                                                                                                                                                                                                                              | Each is executed by a feature that has its own tool; they are covered through those tools                                                                                      |
| Sibling repository `ansible-playbook-deploy`                                                                                                                                                                                                                                                                                                                                                                                       | A separate project; CloudForge ships its own playbooks inside `packages/deployment`. MCP for it would be a separate plan                                                       |

---

## 9. Implementation phases

Each phase ends green: `format:check`, `lint`, `typecheck`, `test`. The audit
runs after the dependency is added. Nothing is committed without your request.

| Phase                                  | Content                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Safety prerequisites**            | P1–P7 (§3); path options on the 6 dialog channels; partial `credentials:update`; server `lastModified` for Nginx. Tests for each.                                                                                                                                                                                                                       |
| **1. MCP core**                        | SDK dependency + audit; registry `dispatch` refactor; HTTP server (loopback, token, host/origin checks); MCP sessions + pinning; tiers, toolsets, approvals, audit; device-level MCP settings; `coverage.ts` guard + tests; `app:dataChanged` / `projects:sessionChanged` + renderer sync map.                                                          |
| **2. Operations and terminal buffers** | Event bus, operation manager, progress notifications, `operations_*`, `terminal_read`.                                                                                                                                                                                                                                                                  |
| **3. Tool catalogue**                  | 3a app, projects, credentials, settings, backup, SSH keys, activity, logs, updates, plugins · 3b providers, cloud firewall, infrastructure, templates · 3c targets/Ansible, deployments, containers, runtime, host firewall, host access, terminal · 3d Nginx, SSL, Cloudflare, domains, WordPress, stacks, Jenkins.                                    |
| **4. New channels**                    | Every row marked **new** in §4: renew SSL now, withdraw DNS, target get, custom template get, resource presets, SSH connections, DNS templates, backup compare, host access instructions, firewall analyze/history, terminal exec, background jobs, log prune, credential kinds, activity filters, analytics ranges, UI commands, docs.                 |
| **5. UI**                              | Settings → MCP page (switch, port, token, ready-to-paste config for Claude Code and Claude Desktop, clients, tiers, toolsets, project unlock option); approval dialog; titlebar badge.                                                                                                                                                                  |
| **6. Resources, prompts, bridge**      | §2.10, stdio bridge, packaging (installer includes the bridge).                                                                                                                                                                                                                                                                                         |
| **7. Verification and docs**           | Unit tests per binding; an in-process MCP client test that lists every tool and checks the coverage table; manual run with Claude Code against the dev app (read tools first; any write against a real server only with your explicit approval per action); `docs/MCP.md` user guide, `docs/IPC.md`, `docs/SECURITY.md` (threat model), `CHANGELOG.md`. |

---

## 10. Decisions for you (my recommendation first)

1. **Transport** — HTTP on localhost **and** the stdio bridge (Claude Desktop needs stdio). _Alternative:_ HTTP only.
2. **Default tiers** — R on, W on, C ask each time, S off, X off, L on. _Alternative:_ everything "ask each time" at first.
3. **Open/switch projects through MCP** — off by default (the passkey would go through the AI).
4. **Terminal exec** — build `terminal_exec` but keep tier X off by default.
5. **Approval for `targets_create` / `ansible_run_profile`** — tier W (no dialog). _Alternative:_ make them C.
6. **Pre-existing bugs (Appendix B)** — fix only those on the MCP path (P1–P7, B-2, B-12); list the rest for a separate task.
7. **Version** — ship as `0.5.0` once done (you decide when to release).

---

## Appendix A — Channel → tool index (all 195)

Every channel appears exactly once in sections 4.1–4.22. Channels that become
several tools: `cloudflare:batchDnsRecords` (4), `providers:instanceAction` (3),
`containers:action` (4), `ssl:export` (2), `ansible:jenkinsAction` (2).
Channels unused by the UI today but exposed: `app:ping`, `projects:get`,
`projects:count`, `containers:list`, `deploy:count`, `infra:validate`,
`runtime:savePlan`, `runtime:validatePlan`, `cloudflare:verifyDns`,
`ansible:status`, `ansible:bootstrap`. Excluded: `logs:report`.

## Appendix B — Pre-existing issues found while reading (not MCP work)

All of these were fixed after the MCP work, at the owner's request. The last column
is how the plan first sorted them, kept for the record. B-8 stayed a rule, with clearer
wording: a project needs a passkey before its secrets can be exported. B-27 was fixed
by removing the option. B-30 was fixed by removing the unused code.

| #    | Issue                                                                                                                                                                                              | Where                                                            | MCP path                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| B-1  | Ansible and Deploy channels trust the caller's fingerprint                                                                                                                                         | `ansible.handlers.ts`, `deploy.handlers.ts`                      | Yes (P1, P2)                          |
| B-2  | "Default region" setting has no effect; project creation hard-codes `af-casablanca-1`                                                                                                              | `WorkspaceGate.tsx:295`                                          | Yes                                   |
| B-3  | Background Cloudflare sync blocks Lock/Switch                                                                                                                                                      | `container.ts:663`                                               | Yes (P7)                              |
| B-4  | Plan validation and destructive confirmation only in the UI                                                                                                                                        | `InfrastructurePage.tsx`, `infrastructure-service.ts`            | Yes (P3, P4)                          |
| B-5  | `ServerAccessCard` and `HostFirewallCard` cache targets under `['ansible:targets']`, so new or deleted targets don't show                                                                          | `ServerAccessCard.tsx:113`, `HostFirewallCard.tsx:57`            | No                                    |
| B-6  | Cancelling the folder picker leaves "Import project" stuck on "Importing…"                                                                                                                         | `WorkspaceGate.tsx:116-124`                                      | No                                    |
| B-7  | Silent failures: settings saves, updates page, credential delete message, Cloudflare zone/record delete, zone settings, firewall load, instance start/stop, container logs/stats, DNS export       | several                                                          | No                                    |
| B-8  | A project without a passkey cannot export a backup                                                                                                                                                 | `SettingsPage.tsx:39, 530`                                       | No                                    |
| B-9  | Settings inputs are uncontrolled and save on every blur                                                                                                                                            | `SettingsPage.tsx`                                               | No                                    |
| B-10 | Enter bypasses the empty-passkey guard on the project card                                                                                                                                         | `WorkspaceGate.tsx:257-269`                                      | No                                    |
| B-11 | Dashboard counts are hard-coded                                                                                                                                                                    | `DashboardPage.tsx:20-32`                                        | No                                    |
| B-12 | VPS runtime apply output is never shown (`runtime:log` not subscribed)                                                                                                                             | `VpsRuntimePage.tsx`                                             | Yes (log needed for MCP too)          |
| B-13 | "Custom image OCID / AMI ID…" never shows its input                                                                                                                                                | `ResourceEditor.tsx:211-286`                                     | No                                    |
| B-14 | Flex OCPU/memory stay hidden in the plan after switching to a fixed shape                                                                                                                          | `ResourceEditor.tsx`                                             | No                                    |
| B-15 | SSL ZIP export (contains the private key) has no confirmation; export uses the current target with rows loaded from another                                                                        | `SslPage.tsx:164-196`                                            | No                                    |
| B-16 | Nginx: switching target keeps the loaded `nginx.conf`, which could then be saved to the other server                                                                                               | `NginxPage.tsx:153-160`                                          | No (important)                        |
| B-17 | Nginx log export file name uses the current kind, not the loaded one                                                                                                                               | `NginxPage.tsx:562-568`                                          | No                                    |
| B-18 | Ansible: after "Prepare VPS" the re-check uses the Playbooks-tab profile; profile states re-query on every keystroke; PostgreSQL "Load access" fails unless the password is retyped                | `AnsiblePage.tsx`                                                | No                                    |
| B-19 | Jenkins: build values can differ from what the selects show; `CONFIRM_WIPE=WIPE` runs with no confirmation                                                                                         | `JenkinsPage.tsx:125, 751`                                       | Partly (MCP treats WIPE as C)         |
| B-20 | WordPress compose-name preview ignores the 40-character limit                                                                                                                                      | `WordPressPage.tsx:266-275`                                      | No                                    |
| B-21 | The Infrastructure page writes decrypted private keys to disk on load, without a click                                                                                                             | `InfrastructurePage.tsx:467-492`                                 | No (review)                           |
| B-22 | Infrastructure Apply re-saves the plan before the confirmation                                                                                                                                     | `InfrastructurePage.tsx:234`                                     | No                                    |
| B-23 | `navigator.clipboard` copies fail (permissions are denied in main) yet show "Copied"                                                                                                               | `RevealDialog.tsx:78`, `SshKeysPage.tsx:121`, `LogsPage.tsx:128` | No                                    |
| B-24 | Cloudflare page: "All zones" can't be selected; a template click while editing turns Create into Update; tags not trimmed; selection survives filters                                              | `CloudflarePage.tsx`                                             | No                                    |
| B-25 | No activity recorded for credentials, SSH keys, targets, plugins, settings, backups, instance start/stop, stack update/redeploy, WordPress redeploy, bootstrap, network create, preview, templates | services/handlers                                                | MCP calls are audited; UI gap remains |
| B-26 | Provider gaps: OCI has no image listing, AWS has no firewall; plan kinds `loadBalancer`, `dns`, `objectStorage` are accepted but never created                                                     | `oracle-provider.ts`, `aws-provider.ts`, Pulumi programs         | No                                    |
| B-27 | `DeploymentContext.domain` is accepted but no template uses it                                                                                                                                     | `deployment-template.ts:18`                                      | No                                    |
| B-28 | Template apply / mode change / release / open ports have no confirmation                                                                                                                           | `TemplatesPage.tsx`, `VpsRuntimePage.tsx`                        | P6 for MCP                            |
| B-29 | Titlebar shows "⌘K" on Windows (shortcut is Ctrl+K)                                                                                                                                                | `Titlebar.tsx`                                                   | No                                    |
| B-30 | `runtime.plan.deleted` activity can never fire (dead path)                                                                                                                                         | `runtime-plan-service.ts:1053`                                   | No                                    |
