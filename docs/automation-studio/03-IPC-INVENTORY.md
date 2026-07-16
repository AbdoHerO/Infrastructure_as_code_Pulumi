# Phase 0 — Complete IPC Inventory (from `contract.ts`, not docs)

Source of truth: `apps/desktop/src/shared/ipc/contract.ts` (`IpcContract` + `IPC_CHANNELS`,
`IpcEventContract` + `IPC_EVENT_CHANNELS`). **149 invoke channels, 10 event channels**, verified
1:1 against `registerHandler` calls across 20 handler modules in `apps/desktop/src/main/ipc/handlers/`.

## Mechanics
- Preload exposes exactly `window.cloudforge = { invoke(channel, payload), subscribe(channel, listener) }`.
  `subscribe` rejects channels not in `IPC_EVENT_CHANNELS`; `invoke` is typed-constrained only.
- `registerHandler` wraps every handler: success → `{ok:true, value}`; throw → `toAppError` →
  `{ok:false, error: SerializedAppError}`. Every call logs channel + duration (payloads never logged).
- `orThrow(result)` unwraps service `Result`s inside handlers.
- **No runtime payload validation (no zod), no sender validation** — trust = contextIsolation +
  sandbox + minimal bridge. (A workflow engine adding channels should consider input validation.)
- Streaming pattern: request carries a client-generated `streamId`; progress arrives on a `*:log`
  event with that `streamId`; response is the terminal result. Cancellation channels:
  `deploy:cancel`, `ansible:cancel` (AbortController maps; reusing an active streamId throws).

## Event channels (main → renderer)

| Event | Payload | Emitted during |
|---|---|---|
| `engine:log` | `{streamId, event: EngineEvent}` | infra preview/apply/destroy/refresh |
| `deploy:log` | `{streamId, event: DeployEvent}` | deploy:run |
| `ansible:log` | `{streamId, event: AnsibleEvent}` | ansible repair/bootstrap/run/jenkinsAction/nginxUpsert/nginxRemove |
| `nginx:log` | `{streamId, event: NginxEvent}` | nginx saveSite/removeSite/saveConfig/reload/restore |
| `ssl:log` | `{streamId, event: CertificateEvent}` | ssl:issue |
| `updates:state` | `UpdateState` | update lifecycle |
| `vpsTargets:changed` | `{reason: created\|updated\|deleted\|synchronized}` | target CRUD, infra apply/destroy/outputs, reconcile |
| `cloudflare:changed` | `{reason: zone-added\|zone-deleted\|dns-changed\|security-changed\|ssl-changed\|cache-changed\|synchronized}` | container auto-sync |
| `terminal:data` | `{sessionId, data}` | PTY output |
| `terminal:closed` | `{sessionId, reason?}` | PTY close |

## Invoke channels by module

Format: `channel` — request → response (streams event / notes). Handler file in parentheses.

### app (app.handlers.ts)
- `app:getInfo` — void → `AppInfo`
- `app:ping` — string → string
- `app:openExternal` — `{link: 'github'|'releases'}` → void (allowlisted)
- `app:copyDiagnostics` — void → void
- `app:copyText` — `{text}` → void
- `app:synchronize` — void → `{warnings: string[]}` (reconcile + Cloudflare sync)

### projects (projects.handlers.ts)
- `projects:list` — void → `ProjectDto[]`
- `projects:get` — `{id}` → `ProjectDto`
- `projects:create` — `CreateProjectInput` → `ProjectDto` (audited)
- `projects:update` — `{id, changes}` → `ProjectDto` (via ProjectConfigurationService)
- `projects:delete` — `{id}` → void (stack check + target cleanup; emits `vpsTargets:changed`)
- `projects:count` — void → number

### credentials + security (credentials.handlers.ts)
- `credentials:list` — void → `CredentialSummaryDto[]`
- `credentials:create` — `CreateCredentialInput` → `CredentialSummaryDto`
- `credentials:reveal` — `{id}` → `RevealedCredentialDto`
- `credentials:delete` — `{id}` → void
- `security:status` — void → `{backedByOsKeychain}`

### settings (settings.handlers.ts)
- `settings:get` — void → `AppSettings`
- `settings:update` — `SettingsPatch` → `AppSettings` (side effects: pruneLogs, update-manager)

### providers + firewall (providers.handlers.ts)
- `providers:test` — `{credentialId}` → `ConnectionTestResult`
- `providers:listRegions` / `listShapes` / `listImages` / `listAvailabilityDomains` /
  `listInstances` / `listResources` — `{credentialId}` → typed lists
- `providers:instanceAction` — `{credentialId, instanceId, action}` → `CloudInstance`
- `providers:terminateInstance` — `{credentialId, instanceId}` → void (audited)
- `firewall:get` — `{credentialId, instanceId}` → `InstanceFirewall`
- `firewall:update` — `{credentialId, instanceId, expectedRules, rules}` → `InstanceFirewall`
  (optimistic concurrency; audited)

### infra (infra.handlers.ts) — streams `engine:log`
- `infra:engineStatus` — void → `{available}`
- `infra:getPlan` — `{projectId}` → `InfrastructurePlan | null`
- `infra:savePlan` — `{projectId, plan}` → void
- `infra:validate` — `{plan}` → `PlanIssue[]`
- `infra:preview` — `{projectId, streamId}` → `PreviewResult` ⚡
- `infra:apply` — `{projectId, streamId, previewToken}` → `ApplyResult` ⚡ (+`vpsTargets:changed`)
- `infra:destroy` — `{projectId, streamId}` → void ⚡ (+`vpsTargets:changed`)
- `infra:refresh` — `{projectId, streamId}` → void ⚡
- `infra:outputs` — `{projectId}` → `Record<string, unknown>` (+`vpsTargets:changed`)
- `infra:managedStacks` — void → `ManagedStackSummary[]`
- `infra:destroyStack` — `{ref: {project, stack}, streamId}` → void ⚡ (+`vpsTargets:changed`)
- `infra:templates` — void → `InfrastructureTemplateSummary[]`
- `infra:applyTemplate` — `{projectId, templateId, sshPublicKey?, sshCredentialId?, region?}` → `InfrastructurePlan`
- `infra:customTemplates` — void → `CustomTemplateSummary[]`
- `infra:saveTemplate` — `{name, description?, plan}` → `CustomTemplateSummary`
- `infra:deleteTemplate` — `{id}` → void
- `infra:applyCustomTemplate` — `{projectId, templateId}` → `InfrastructurePlan`

### deploy (deploy.handlers.ts) — streams `deploy:log`
- `deploy:templates` — void → `DeploymentTemplateSummary[]`
- `deploy:list` — `{projectId}` → `DeploymentDto[]`
- `deploy:count` — void → number
- `deploy:inspectHostKey` — `{host, port}` → `{fingerprint}`
- `deploy:run` — `{projectId, templateId, host, port, username, sshCredentialId, hostKeySha256, appImage?, domain?, streamId}` → `DeploymentDto` ⚡ (audited)
- `deploy:cancel` — `{streamId}` → void

### containers (containers.handlers.ts) — `ContainerTargetRequest = {host, port, username, sshCredentialId, hostKeySha256}`
- `containers:list` — target → `RemoteContainer[]`
- `containers:action` — target + `{containerId, action}` → void
- `containers:logs` — target + `{containerId, lines?}` → `{text}`
- `containers:stats` — target + `{containerId}` → `ContainerStats`
- `containers:deployCompose` — target + `{projectName, composeYaml}` → void

### terminal (terminal.handlers.ts) — streams `terminal:data` / `terminal:closed`
- `terminal:open` — `{targetId, sessionId, columns, rows}` → void
- `terminal:write` — `{sessionId, data}` → void
- `terminal:resize` — `{sessionId, columns, rows}` → void
- `terminal:close` — `{sessionId}` → void

### ansible (ansible.handlers.ts) — streams `ansible:log`; `SshTargetRequest = {host, port, username, sshCredentialId, hostKeySha256}`
- `ansible:profiles` — void → `AnsibleProfile[]`
- `ansible:targets` — void → `VpsTargetDto[]`
- `ansible:createTarget` / `updateTarget` — `SaveVpsTargetRequest(+id)` → `VpsTargetDto` (+`vpsTargets:changed`)
- `ansible:deleteTarget` — `{id}` → void (+`vpsTargets:changed`)
- `ansible:inspectHostKey` — `{host, port}` → `{fingerprint}`
- `ansible:status` — target → `AnsibleStatus`
- `ansible:profileStates` — target → `AnsibleProfileState[]`
- `ansible:preflight` — target + `{targetId?, profileId?, variables?}` → `VpsPreflightReport`
- `ansible:repair` — target + `{targetId?, streamId}` → `VpsPreflightReport` ⚡ (audited)
- `ansible:bootstrap` — target + `{streamId}` → `AnsibleStatus` ⚡
- `ansible:run` — target + `{profileId, variables, streamId}` → `AnsibleOutcome` ⚡ (audited)
- `ansible:jenkinsAction` — target + `{action: verify|restart, streamId}` → `AnsibleOutcome` ⚡ (audited)
- `ansible:access` — target + `{profileId, variables}` → `AnsibleAccessDetails | null`
- `ansible:cancel` — `{streamId}` → void
- `ansible:nginxSites` — target → `NginxSite[]`
- `ansible:nginxUpsert` — target + `{site, streamId}` → `AnsibleOutcome` ⚡ (audited)
- `ansible:nginxRemove` — target + `{domain, streamId}` → `AnsibleOutcome` ⚡ (audited)

### nginx (nginx.handlers.ts) — targetId-based; streams `nginx:log`
- `nginx:inspect` — `{targetId}` → `NginxOverview`
- `nginx:listSites` — `{targetId}` → `ManagedNginxSite[]`
- `nginx:saveSite` — `{targetId, site, streamId}` → `NginxOperationOutcome` ⚡
- `nginx:removeSite` — `{targetId, domain, streamId}` → `NginxOperationOutcome` ⚡
- `nginx:readConfig` — `{targetId}` → `{content}`
- `nginx:saveConfig` — `{targetId, content, streamId}` → `NginxOperationOutcome` ⚡
- `nginx:reload` — `{targetId, streamId}` → `NginxOperationOutcome` ⚡
- `nginx:liveStatus` — `{targetId}` → `NginxLiveStatus`
- `nginx:logs` — `{targetId, query}` → `{lines: string[]}`
- `nginx:backups` — `{targetId}` → `NginxBackup[]`
- `nginx:readBackupConfig` — `{targetId, backupId}` → `{content}`
- `nginx:restore` — `{targetId, backupId, streamId}` → `NginxOperationOutcome` ⚡

### ssl (ssl.handlers.ts) — streams `ssl:log`
- `ssl:verifyDns` — `{targetId, domain}` → propagation report (status/provider/proxied/sslMode/…)
- `ssl:list` — `{targetId, certificateVolume}` → `CertificateDetails[]`
- `ssl:issue` — `{targetId, config, streamId}` → `CertificateDetails` ⚡
- `ssl:export` — `{targetId, certificateVolume, domain, format: pem|crt|key|zip}` → `{name, contentBase64}`

### cloudflare (cloudflare.handlers.ts)
- `cloudflare:test` — `{credentialId}` → `ServiceConnection`
- `cloudflare:dashboard` — `{credentialId, zoneId?}` → `CloudflareDashboard`
- `cloudflare:zones` — `{credentialId}` → `CloudflareZone[]`
- `cloudflare:createZone` — `{credentialId, name, accountId?}` → `CloudflareZone`
- `cloudflare:deleteZone` — `{credentialId, zoneId}` → void
- `cloudflare:dnsRecords` — `{credentialId, zoneId}` → `CloudflareDnsRecord[]`
- `cloudflare:createDnsRecord` / `updateDnsRecord` / `deleteDnsRecord` — record CRUD
- `cloudflare:batchDnsRecords` — `{credentialId, zoneId, action}` → `{changed}`
- `cloudflare:ensureDns` — `{credentialId?, zoneId?, domain, expectedIp}` → `CloudflareDnsPropagation` (polls)
- `cloudflare:verifyDns` — same request → `CloudflareDnsPropagation`
- `cloudflare:zoneSettings` / `updateZoneSettings` — settings read/patch
- `cloudflare:purgeCache` — `{credentialId, zoneId}` → void
- `cloudflare:security` — `{credentialId, zoneId}` → `CloudflareSecurityOverview`
- `cloudflare:analytics` — `{credentialId, zoneId, since, until}` → `CloudflareAnalytics`
- `cloudflare:pageRules` / `savePageRule` / `deletePageRule` — page rules CRUD
- `cloudflare:redirectRules` / `saveRedirectRule` / `deleteRedirectRule` — redirect rules CRUD
- `cloudflare:platform` — `{credentialId, zoneId, accountId}` → `CloudflarePlatformSummary`

### jenkins (jenkins.handlers.ts)
- `jenkins:list` — void → `JenkinsPipelineRecord[]`
- `jenkins:test` — `{targetId, credentialId}` → `{version}`
- `jenkins:save` — `SaveJenkinsPipelineInput` → `JenkinsPipelineRecord`
- `jenkins:delete` — `{id}` → void
- `jenkins:trigger` — `{id, parameters}` → void
- `jenkins:status` — `{id}` → `JenkinsJobStatus`

### sshKeys (ssh-keys.handlers.ts)
- `sshKeys:list` — void → `SshKeySummary[]`
- `sshKeys:generate` — `{name, algorithm, passphrase?}` → `SshKeySummary`
- `sshKeys:import` — `{name, privateKey, passphrase?}` → `SshKeySummary`
- `sshKeys:revealPrivate` — `{id}` → `{privateKey}`
- `sshKeys:exportPrivate` — `{id, suggestedName}` → `{path | null}` (save dialog, 0600)
- `sshKeys:materializePrivate` — `{id, suggestedName}` → `{path}` (`~/.ssh`, 0600)
- `sshKeys:delete` — `{id}` → void

### activity / plugins / updates / logs / backup
- `activity:list` — `{limit?}` → `ActivityDto[]` (default 200)
- `plugins:list` / `plugins:active` / `plugins:install` / `plugins:setEnabled` / `plugins:uninstall`
- `updates:state` / `updates:check` / `updates:download` / `updates:install`
- `logs:info` — void → `{path, dir}` · `logs:tail` — `{lines?}` → `string[]` ·
  `logs:openFolder` — void → void · `logs:report` — `{level, message, stack?, source?}` → void
- `backup:create` — `{passphrase}` → `{path | null}` · `backup:restore` — `{passphrase}` → `{restored}`

## Automation Studio implications
1. Every channel already has a typed request/response — node input/output schemas can be derived
   from the contract types directly.
2. The engine should call **application services, not IPC channels** (same layer as handlers do),
   but the contract table above is the authoritative catalog of what exists.
3. Ansible/container channels take raw `SshTargetRequest`; the handler resolves credentials
   main-side (`resolveSshTarget`). Workflow nodes should be **targetId-based** (like nginx/ssl/
   terminal) to avoid passing connection material through workflow definitions.
4. New IPC needed for Automation Studio (workflow CRUD, execution control, execution log
   streaming) must follow: contract-first typing, `registerHandler`, `orThrow`, `streamId` events,
   and the add-a-channel checklist in docs/IPC.md.
