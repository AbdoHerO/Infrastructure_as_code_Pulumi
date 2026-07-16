# Phase 0 — Complete Application Service Inventory

All services live in `packages/core/src/application/` and are wired in
`apps/desktop/src/main/container.ts` (manual constructor injection, singleton container).
Every async method returns `Result<T, E>` — services never throw across boundaries.
"Streams" = accepts an event sink callback (long-running, correlated by `streamId` at the IPC layer).

## Container wiring order (composition root)

```
db (Prisma/SQLite) → cipher (safeStorage|AES-GCM)
 1. ProjectService(PrismaProjectRepository)
 2. CredentialService(PrismaCredentialRepository, cipher)
 3. SettingsService(PrismaSettingsRepository)          → eager settings load, pruneLogs
 4. ProviderConnectionService(credentialService, DefaultProviderFactory)
 5. credentialResolver (inline ProviderCredentialResolver)
 6. DeploymentService(SshDeployer, PrismaDeploymentRepository) → recoverInterrupted()
 7. ActivityService(PrismaActivityRepository)
 8. CloudflareService(credentialService, DefaultServiceProviderFactory, activity, settings)
 9. PluginService(PrismaPluginRepository)
10. SshKeyService(credentialService, NodeSshKeyGenerator)
11. containerManager = SshContainerManager()            ← port, no service wrapper
12. ansibleManager  = SshAnsibleManager()               ← port, no service wrapper
13. VpsTargetService(PrismaVpsTargetRepository)
14. ManagedVpsTargetSyncService(vpsTargets, sshKeys, deployments)  ← internal, not exposed
15. InfrastructureService(PulumiEngine, PrismaPlanStore, credentialResolver, PrismaTemplateStore, targetSync)
16. ProjectConfigurationService(projects, infrastructure, projectStackReference, activity)
17. remoteTargetResolver (inline RemoteTargetResolver: target → decrypted SSH material)
18. NginxService(remoteTargetResolver, SshNginxManager, activity)
19. SshTerminalService(remoteTargetResolver, NodeSshTerminalManager, activity)
20. domainResolver (inline DomainResolver: resolve4/6 + lookup fallback)
21. CloudflareDnsAutomationService(cloudflare, settings, domainResolver, activity)
22. JenkinsPipelineService(PrismaJenkinsPipelineRepository, vpsTargets, credentials,
        JenkinsHttpManager, activity, cloudflareDnsAutomation, nginx)
23. SslService(remoteTargetResolver, domainResolver, SshCertificateManager, activity,
        settings, nginx, cloudflareDnsAutomation)
Timers: SSL renewDue (interval + 30s one-shot) · Cloudflare sync (interval) ·
        reconcileManagedTargets (2s) · synchronizeCloudflare (5s)
```

---

## 1. ProjectService — `projects/project-service.ts`
Project CRUD over the `Project` aggregate.
- `create(input)` → `ProjectDto` · `list()` · `get(id)` · `update(id, input)` ·
  `previewUpdate(id, input)` (pure) · `remove(id)` · `count()`
- Errors: `ValidationError | NotFoundError | PersistenceError`
- **Workflow nodes**: Create Project, Get Project, Delete Project.

## 2. ProjectConfigurationService — `projects/project-configuration-service.ts`
Guards project metadata edits while a live stack exists.
- `update(id, input)` → `ProjectDto` — checks managed stacks, may rewrite plan region,
  rolls back plan on failure, `ConflictError` on protected-field change with live stack. Audited.
- **Workflow node**: Update Project (safe).

## 3. CredentialService — `credentials/credential-service.ts`
Encrypted credential manager (SecretCipher port).
- `create(input)` · `list()` · `reveal(id)` · `getDecrypted(id)` (internal, domain entity) ·
  `remove(id)` · `exportPortableSecrets()` · `importPortableSecrets(secrets)`
- **Workflow relevance**: internal dependency of nearly everything; probably NOT exposed as
  nodes except maybe "test"-style checks (secrets should not flow through workflow state).

## 4. SettingsService — `settings/settings-service.ts`
`AppSettings` JSON blob merged over defaults (key `app.settings`).
- `get()` · `update(patch)` (normalizes/clamps)
- **Workflow node candidates**: Read Setting (as workflow input), Update Setting (careful).

## 5. ProviderConnectionService — `providers/provider-connection-service.ts`
Cloud provider operations for a stored credential (decrypt → factory → capability).
- `testConnection(credId)` · `listRegions` · `listShapes` · `listImages` ·
  `listAvailabilityDomains` · `listInstances` · `listResources` ·
  `instanceAction(credId, instanceId, start|stop|reboot)` · `terminateInstance(credId, instanceId)` ·
  `getInstanceFirewall(credId, instanceId)` · `updateInstanceFirewall(credId, instanceId, rules)`
- Errors: `ProviderError`. Mutates live cloud resources. OCI actions poll to target state.
- **Workflow nodes**: Test Connection, all List* (discovery), Instance Start/Stop/Reboot,
  Terminate Instance, Get/Update Firewall.

## 6. InfrastructureService — `infrastructure/infrastructure-service.ts`
IaC coordinator: plan persistence + Pulumi engine driving. Holds in-memory preview-token map.
- `isEngineAvailable()` · `listManagedStacks()` · `getPlan(projectId)` · `savePlan(projectId, plan)` ·
  `validate(plan)` (pure) · `listTemplates()` (pure) · `applyTemplate(projectId, templateId, ctx)` ·
  `listCustomTemplates()` · `saveCustomTemplate(input)` · `deleteCustomTemplate(id)` ·
  `applyCustomTemplate(projectId, templateId)`
- **Streaming**: `preview(ref, projectId, onEvent)` → `PreviewResult` + one-use `previewToken` ·
  `apply(ref, projectId, previewToken, onEvent)` → `ApplyResult` (validates token+fingerprint,
  triggers targetSync) · `destroy(ref, projectId, onEvent)` · `destroyManagedStack(ref, onEvent)` ·
  `refresh(ref, onEvent)` · `outputs(ref, projectId?, onEvent?)`
- **Workflow nodes**: Save Plan, Validate Plan, Apply Template, Preview, Apply (must chain from
  Preview for the token), Destroy, Refresh, Get Outputs, Destroy Stack.

## 7. DeploymentService — `deployment/deployment-service.ts`
SSH step-runner pipeline from built-in templates.
- `listTemplates()` (pure) · `list(projectId)` · `count()` · `inspectHostKey(host, port)` ·
  `recoverInterrupted()` · **`run(input, onEvent, options)`** (streaming, cancellable via
  AbortSignal, records Deployment row running→success/failed)
- **Workflow nodes**: Run Deployment, Inspect Host Key.

## 8. ActivityService — `activity/activity-service.ts`
Audit feed. `record(input)` · `recordSafe(input)` (fire-and-forget; the standard audit hook) ·
`list(limit=200)`.
- **Workflow nodes**: Record Activity (workflow steps should audit), List Activity (trigger source?).

## 9. PluginService — `plugins/plugin-service.ts`
Declarative catalog merge. `list()` · `install(id)` · `active()` · `setEnabled(id, on)` · `uninstall(id)`.
- **Workflow relevance**: low.

## 10. SshKeyService — `ssh-keys/ssh-key-service.ts`
SSH keys stored as encrypted credentials.
- `list()` · `generate(name, algorithm, passphrase?)` · `import(name, privateKey, passphrase?)` ·
  `revealPrivate(id)` · `resolveAuthentication(id)` (internal) · `findByPublicKey(pub)` · `remove(id)`
- **Workflow nodes**: Generate Key, Import Key (secret-returning ops should stay out of workflow state).

## 11. VpsTargetService — `vps-targets/vps-target-service.ts`
Saved/verified SSH target catalog (shared connection identity for ALL SSH features).
- `list()` · `get(id)` · `create(input)` · `update(id, input)` · `recordPreflight(id, report)` ·
  `remove(id)` · `upsertManaged(...)` · `removeManagedProject/Resource(s)...` (reconciliation)
- **Workflow nodes**: List/Get Target (workflow input), Create/Update/Delete Target.

## 12. ManagedVpsTargetSyncService — `vps-targets/managed-vps-target-sync-service.ts`
Stack outputs → VPS target catalog. NOT exposed on container.
- `sync(projectId, plan, outputs, onEvent?)` → `{targets, warnings}` (retries host-key inspect
  20×3s until SSH ready) · `removeProject(projectId)` → warnings
- Returns warnings, not Result. Triggered internally by Infra apply/outputs.
- **Workflow relevance**: implicit post-step of Apply node; also a good "Wait for SSH ready" pattern.

## 13. NginxService — `nginx/nginx-service.ts`
Remote Nginx via `NginxManager` + `RemoteTargetResolver`. All mutations transactional
(backup → apply → `nginx -t` → rollback → reload). Audited.
- `inspect(targetId)` · `listSites` · **`saveSite`** (streams) · **`removeSite`** (streams) ·
  `readMainConfig` · **`saveMainConfig`** (streams) · **`reload`** (streams) · `liveStatus` ·
  `readLogs(query)` · `listBackups` · `readBackupConfig` · **`restore`** (streams)
- Pure module exports: `validateManagedNginxSite`, `renderManagedNginxSite`
- **Workflow nodes**: Save Site, Remove Site, Reload, Save Config, Restore Backup, Inspect, Read Logs.

## 14. SslService — `ssl/ssl-service.ts`
DNS-gated Certbot issuance + renewal.
- `verifyDns(targetId, domain)` (Cloudflare-aware) · **`issue(targetId, config, onEvent)`**
  (streams; orchestrates DNS→ACME webroot→Certbot→Nginx SSL→settings) · `list(targetId, volume)` ·
  `export(targetId, volume, domain, pem|crt|key|zip)` · 📅 `renewDue()` (batch, void — timer-driven)
- **Workflow nodes**: Verify DNS, Issue Certificate, List Certificates, Export; Renew-due as scheduled node.

## 15. SshTerminalService — `terminal/ssh-terminal-service.ts`
Interactive PTY sessions on saved targets. `open(targetId, sessionId, size, sink)` ·
`write` · `resize` · `close` · `closeAll` (sync Results).
- **Workflow relevance**: NOT a workflow node (interactive). But a generic "Run SSH command" node
  could reuse the underlying SSH plumbing (`SshDeployer` with a one-step script is the better fit).

## 16. JenkinsPipelineService — `jenkins/jenkins-pipeline-service.ts`
Jenkins job lifecycle + optional domain orchestration.
- `list()` · `test(targetId, credentialId)` · **`save(input)`** (multi-system: folder + GitHub cred +
  job upsert + rename cleanup + DB + optional Cloudflare DNS + Nginx site + HOST_PORT param sync) ·
  `trigger(id, parameters)` · `status(id)` · `remove(id)`
- **Workflow nodes**: Save Pipeline, Trigger Build, Get Build Status (poll-until-done composite),
  Test Connection, Delete Pipeline.

## 17. CloudflareService — `service-providers/cloudflare-service.ts`
Full Cloudflare surface for a stored credential. All mutations audited (gated by settings).
- `test` · `zones` · `createZone` · `deleteZone` · `dashboard` · `dnsRecords` · `createDnsRecord` ·
  `updateDnsRecord` · `deleteDnsRecord` · `batchDnsRecords` · `zoneSettings` · `updateZoneSettings` ·
  `purgeCache` · `security` · `analytics(since, until)` · `pageRules` · `savePageRule` ·
  `deletePageRule` · `redirectRules` · `saveRedirectRule` · `deleteRedirectRule` · `platform`
- **Workflow nodes**: nearly all of the above map 1:1.

## 18. CloudflareDnsAutomationService — `service-providers/cloudflare-dns-automation-service.ts`
Implements the `ManagedDnsCoordinator` port. Domain→IP record ensure + propagation wait.
- `ensure(domain, expectedIp, credId?, zoneId?)` (polls 5s up to settings timeout) ·
  `verify(domain, expectedIp, ...)`
- **Workflow nodes**: Ensure DNS (wait-for-propagation built in), Verify DNS.

---

## Ports without a service wrapper (called directly by IPC handlers)

### AnsibleManager (`SshAnsibleManager`, packages/deployment)
`profiles()` · `inspectHostKey` · `status(target)` · `profileStates(target)` ·
`preflight(target, profileId?, vars?)` · `repair(target, onEvent, opts)` ·
`bootstrap(target, onEvent, opts)` · **`run(target, profileId, vars, onEvent, opts)`** ·
`manageJenkins(target, verify|restart, onEvent, opts)` · `access(target, profileId, vars)` ·
`listNginxSites(target)` · `upsertNginxSite(target, site, onEvent, opts)` ·
`removeNginxSite(target, domain, onEvent, opts)`
— all take a resolved `DeploymentTarget` (handler resolves via `resolveSshTarget`). Cancellable.
**Automation Studio should introduce an `AnsibleService` wrapper** (targetId-first, like NginxService)
rather than duplicating handler-level resolution logic.

### ContainerManager (`SshContainerManager`, packages/deployment)
`list(target)` · `action(target, id, start|stop|restart|remove)` · `logs(target, id, lines)` ·
`stats(target, id)` · `deployCompose(target, projectName, composeYaml)`
— same recommendation: wrap as `ContainerService(remoteTargetResolver, containerManager, activity)`.

---

## Main-process capabilities outside core (handler/manager level)
- **Update manager**: `checkForUpdates` / `downloadUpdate` / `installUpdate` / state push
- **Backup**: create (VACUUM INTO + portable secrets envelope), restore (validated, rollback, relaunch)
- **`container.synchronizeData()`**: managed-target reconcile + Cloudflare sync (exposed as `app:synchronize`)
- **Logs**: tail/info/openFolder/report

## Cross-cutting facts for the workflow engine
- Event sinks all share `{stream: 'step'|'stdout'|'stderr'|'error', message}`; `EngineEvent` adds
  structured per-resource progress. One generic "streaming node executor" covers all of them.
- Cancellation: `AbortSignal` supported by deploy + ansible + nginx/cert managers (via options);
  Pulumi operations are NOT cancellable mid-flight.
- Idempotency guards to respect: preview-token (infra apply), `expectedRules` (firewall),
  preflight-must-be-ready (ansible run), host-key pinning (all SSH), loopback guard (jenkins URL).
