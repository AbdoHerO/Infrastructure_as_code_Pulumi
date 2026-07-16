# Phase 0 — Complete Automation Matrix

Every automatable capability in CloudForge, evaluated as an Automation Studio workflow node.

Column legend:
- **Node?** — ✅ should be a node · 🟡 possible but low value / needs care · ❌ not a node (with reason)
- **Svc** — owning application service exists (✔) or needs a wrapper (➕)
- **Out** — returns chainable outputs
- **Par** — safe to run in parallel with unrelated nodes
- **Roll** — has a natural compensation/rollback action

All nodes can fail (uniform `Result`/`AppError`) and can be used conditionally — the engine
provides branching on error code + output predicates, so those columns are omitted where uniform.

## Infrastructure (Pulumi)

| Capability | Node? | Svc | Out | Par | Roll | Notes |
|---|---|---|---|---|---|---|
| Validate plan | ✅ | ✔ InfrastructureService.validate | PlanIssue[] | ✔ | n/a | pure, gate node |
| Save plan | ✅ | ✔ savePlan | — | ✔ | prior plan | |
| Apply built-in/custom template to project | ✅ | ✔ applyTemplate/applyCustomTemplate | plan | ✔ | prior plan | |
| Preview | ✅ | ✔ preview (streams) | PreviewResult + **previewToken** | per-stack ✖ | n/a | token must feed Apply |
| Apply | ✅ | ✔ apply (streams) | ApplyResult.outputs | per-stack ✖ | Destroy | requires previewToken; triggers VPS-target sync internally |
| Destroy (project) | ✅ | ✔ destroy (streams) | — | per-stack ✖ | ✖ irreversible | confirm-gated in UI → workflow needs explicit destructive flag |
| Destroy managed stack | ✅ | ✔ destroyManagedStack | — | per-stack ✖ | ✖ | orphan cleanup |
| Refresh / drift detect | ✅ | ✔ refresh (streams) | — | per-stack ✖ | n/a | |
| Get outputs | ✅ | ✔ outputs | Record<string,unknown> (+SSH hints) | ✔ | n/a | key chain source: `<name>PublicIp`, `<name>SshUser` |
| List managed stacks | ✅ | ✔ listManagedStacks | summaries | ✔ | n/a | discovery/trigger source |
| Engine availability | ✅ | ✔ isEngineAvailable | bool | ✔ | n/a | precondition node |
| Save/delete custom template | 🟡 | ✔ | summary | ✔ | delete/save | admin-ish |

⚠ Pulumi ops are **not cancellable** mid-flight and must be serialized **per stack** (engine needs
a per-stack mutex; Pulumi local backend also file-locks).

## Cloud Providers (Oracle / AWS)

| Capability | Node? | Svc | Out | Par | Roll | Notes |
|---|---|---|---|---|---|---|
| Test connection | ✅ | ✔ ProviderConnectionService | ConnectionTestResult | ✔ | n/a | precondition |
| List regions/shapes/images/ADs | ✅ | ✔ | lists | ✔ | n/a | data source for dynamic inputs |
| List instances / resources | ✅ | ✔ | lists | ✔ | n/a | discovery + iteration source (for-each) |
| Instance start | ✅ | ✔ instanceAction | CloudInstance | per-instance ✖ | stop | polls to RUNNING |
| Instance stop | ✅ | ✔ | CloudInstance | per-instance ✖ | start | destructive-lite |
| Instance reboot | ✅ | ✔ | CloudInstance | per-instance ✖ | n/a | |
| Terminate instance | ✅ | ✔ terminateInstance | — | per-instance ✖ | ✖ irreversible | destructive flag; OCI deletes boot volume |
| Get firewall | ✅ | ✔ getInstanceFirewall | InstanceFirewall (rules snapshot) | ✔ | n/a | snapshot feeds update |
| Update firewall | ✅ | ✔ updateInstanceFirewall | InstanceFirewall | per-instance ✖ | restore prior snapshot | engine should thread `expectedRules` from Get node |

## Deployments / SSH

| Capability | Node? | Svc | Out | Par | Roll | Notes |
|---|---|---|---|---|---|---|
| Inspect host key | ✅ | ✔ DeploymentService | fingerprint | ✔ | n/a | TOFU trust node |
| Run deployment template | ✅ | ✔ run (streams, cancellable) | DeploymentDto + outputs | per-host ✖ | ✖ (steps are imperative) | 6 templates; records history |
| **Run SSH command/script** (generic) | ✅ NEW | ➕ wrap `SshDeployer.deploy` with one ad-hoc step | stdout/exit | per-host ✖ | ✖ | the single most valuable new node; targetId-based |
| Wait for SSH ready | ✅ NEW | ➕ extract from ManagedVpsTargetSyncService retry loop | bool | ✔ | n/a | already implemented as 20×3s retry — promote to node |

## VPS Targets

| Capability | Node? | Svc | Out | Par | Roll |
|---|---|---|---|---|---|
| List/Get target | ✅ | ✔ VpsTargetService | VpsTargetDto | ✔ | n/a |
| Create/Update target | ✅ | ✔ | VpsTargetDto | ✔ | delete/prior |
| Delete target | ✅ | ✔ | — | ✔ | recreate |
| Sync managed targets from outputs | 🟡 | ✔ (internal service) | targets+warnings | ✖ | n/a — implicit in Apply; expose as explicit "Sync targets" node too |

## Ansible (needs an `AnsibleService` wrapper — port is service-less today)

| Capability | Node? | Svc | Out | Par | Roll | Notes |
|---|---|---|---|---|---|---|
| Status / profile states | ✅ | ➕ | AnsibleStatus / states | ✔ | n/a | |
| Preflight | ✅ | ➕ | VpsPreflightReport (ready/needs-repair/blocked) | ✔ | n/a | gate node |
| Bootstrap / Repair | ✅ | ➕ (streams, cancellable) | report | per-host ✖ | ✖ | idempotent |
| Run profile (docker/dockhand/portainer/jenkins/nginx) | ✅ | ➕ (streams, cancellable) | AnsibleOutcome (recap) | per-host ✖ | ✖ but idempotent re-run | auto-runs docker dep; preflight-gated |
| Jenkins verify/restart | ✅ | ➕ (streams) | AnsibleOutcome | per-host ✖ | n/a | |
| Jenkins access details | 🟡 | ➕ | URL + **secret** | ✔ | n/a | secret output — mask in workflow state |
| Nginx sites via ansible (list/upsert/remove) | 🟡 | ➕ | outcome | per-host ✖ | ✖ | overlaps NginxService — prefer nginx nodes |

## Nginx

| Capability | Node? | Svc | Out | Par | Roll | Notes |
|---|---|---|---|---|---|---|
| Inspect / live status | ✅ | ✔ NginxService | overview/status | ✔ | n/a | |
| List sites | ✅ | ✔ | sites | ✔ | n/a | iteration source |
| Save site | ✅ | ✔ (streams) | outcome | per-host ✖ | built-in (auto-backup + nginx -t rollback) | transactional already |
| Remove site | ✅ | ✔ (streams) | outcome | per-host ✖ | restore backup | |
| Save main config | ✅ | ✔ (streams) | outcome | per-host ✖ | built-in | |
| Reload | ✅ | ✔ (streams) | outcome | per-host ✖ | n/a | |
| Read logs | ✅ | ✔ | lines | ✔ | n/a | condition source (error scan) |
| List backups / read backup | ✅ | ✔ | backups | ✔ | n/a | |
| Restore backup | ✅ | ✔ (streams) | outcome | per-host ✖ | re-restore | explicit rollback node |

## SSL / Certificates

| Capability | Node? | Svc | Out | Par | Roll | Notes |
|---|---|---|---|---|---|---|
| Verify DNS | ✅ | ✔ SslService | propagation report | ✔ | n/a | gate node (poll-capable) |
| Issue certificate | ✅ | ✔ (streams) | CertificateDetails | per-host ✖ | ✖ (cert issuance benign) | LE rate limits — engine should warn on retry loops |
| List certificates | ✅ | ✔ | details[] | ✔ | n/a | expiry monitoring trigger source |
| Export certificate | ✅ | ✔ | base64 bundle | ✔ | n/a | |
| Renew due | ✅ | ✔ renewDue (batch, void) | — | ✖ | n/a | today timer-driven; natural scheduled-workflow node |

## Cloudflare

| Capability | Node? | Svc | Out | Par | Roll |
|---|---|---|---|---|---|
| Test connection | ✅ | ✔ CloudflareService | connection | ✔ | n/a |
| List zones / dashboard / security / analytics / platform | ✅ | ✔ | data | ✔ | n/a |
| Create zone | ✅ | ✔ | zone | ✔ | delete zone |
| Delete zone | ✅ | ✔ | — | ✔ | ✖ (destructive flag) |
| DNS record create/update/delete | ✅ | ✔ | record | per-zone ~✔ | inverse op |
| Batch DNS actions | ✅ | ✔ | {changed} | per-zone ✖ | ✖ |
| **Ensure DNS (with propagation wait)** | ✅ | ✔ CloudflareDnsAutomationService | propagation | ✔ | delete record | the flagship composite primitive |
| Verify DNS | ✅ | ✔ | propagation | ✔ | n/a |
| Zone settings read/patch | ✅ | ✔ | settings | per-zone ✖ | patch back prior |
| Purge cache | ✅ | ✔ | — | ✔ | n/a |
| Page/redirect rule save/delete | ✅ | ✔ | rule | per-zone ✖ | inverse |

## Jenkins

| Capability | Node? | Svc | Out | Par | Roll | Notes |
|---|---|---|---|---|---|---|
| Test connection | ✅ | ✔ JenkinsPipelineService | {version} | ✔ | n/a | |
| Save pipeline (job + creds + optional domain) | ✅ | ✔ | record | per-jenkins ✖ | remove | multi-system composite already |
| Trigger build | ✅ | ✔ | — (void!) | ✔ | n/a | no build number returned — see gaps |
| Get status | ✅ | ✔ | JenkinsJobStatus | ✔ | n/a | poll source |
| **Wait for build result** | ✅ NEW | ➕ compose trigger+status polling | build result | ✔ | n/a | needed because trigger returns void |
| Delete pipeline | ✅ | ✔ | — | ✔ | re-save | |

## Containers (needs a `ContainerService` wrapper)

| Capability | Node? | Svc | Out | Par | Roll |
|---|---|---|---|---|---|
| List containers | ✅ | ➕ | RemoteContainer[] | ✔ | n/a |
| Start/Stop/Restart | ✅ | ➕ | — | per-container ✖ | inverse |
| Remove | ✅ | ➕ | — | per-container ✖ | ✖ (destructive) |
| Logs / stats | ✅ | ➕ | text/stats | ✔ | n/a |
| Deploy Compose | ✅ | ➕ | — | per-host ✖ | prior compose re-deploy |

## Projects / Platform

| Capability | Node? | Svc | Out | Par | Roll |
|---|---|---|---|---|---|
| Create project | ✅ | ✔ ProjectService | ProjectDto | ✔ | delete |
| Get/List/Count project | ✅ | ✔ | dto | ✔ | n/a |
| Update project (guarded) | ✅ | ✔ ProjectConfigurationService | dto | ✔ | prior values |
| Delete project | ✅ | ✔ | — | ✔ | ✖ (destructive) |
| Record activity | ✅ | ✔ ActivityService | — | ✔ | n/a — every workflow step should also audit |
| List activity | 🟡 | ✔ | dtos | ✔ | n/a — possible trigger source |
| Read settings | ✅ | ✔ SettingsService | AppSettings | ✔ | n/a |
| Update settings | 🟡 | ✔ | settings | ✖ | prior patch — risky global state |
| Synchronize data | ✅ | ✔ container.synchronizeData | warnings | ✖ | n/a |
| SSH key generate/import | 🟡 | ✔ SshKeyService | summary | ✔ | delete — secret-adjacent |
| Notify / webhook | ✅ NEW | ➕ | — | ✔ | n/a — no notification primitive exists today |

## ❌ Not workflow nodes (justified)
| Capability | Why not |
|---|---|
| Credential create/reveal/delete | secrets must not flow through workflow definitions/state; nodes reference credentials by ID only |
| SSH key reveal/export/materialize | same — plaintext key output |
| Backup create/restore | restores relaunch the app; interactive dialogs; would kill the running engine |
| Updates check/download/install | app lifecycle, not infrastructure |
| Terminal open/write | interactive PTY, human-driven (generic SSH-command node covers automation) |
| Plugins install/enable | app configuration, not infra automation |
| Logs tail/openFolder, app:copyText/copyDiagnostics/openExternal | local desktop utilities |
| projects:previewUpdate, infra:validate (client) | pure helpers, folded into their parent nodes |

## Trigger inventory (what can start a workflow, based on existing signals)
- **Manual** (UI button) — trivially available
- **Schedule** — precedent: container `setInterval` timers (SSL renew, CF sync); needs persistence
- **Event**: `vpsTargets:changed`, `cloudflare:changed` (already emitted); Activity records;
  deployment completion; update states
- **Poll-based conditions**: cert days-remaining (`ssl:list`), jenkins build status, DNS propagation,
  instance state, nginx liveStatus — all cheap read nodes usable as condition sources

## Engine-level requirements distilled from the matrix
1. **Concurrency keys**: per-stack (Pulumi file lock), per-host (SSH ops), per-zone (CF mutations),
   per-instance (provider actions). Parallel branches must respect these mutexes.
2. **Streaming**: one generic node-execution log pipe over a new `workflow:log` event channel,
   fanning in the existing sink events with node correlation.
3. **Cancellation**: propagate AbortSignal to deploy/ansible/nginx/cert managers; document that
   Pulumi nodes cannot abort mid-operation.
4. **Secrets**: nodes carry credential IDs / target IDs only; resolution happens main-side at
   execution time (same as `resolveSshTarget`).
5. **Destructive gates**: destroy/terminate/delete-zone/remove-container nodes need an explicit
   "allow destructive" flag on the workflow + confirmation at save time (house rule: no silent
   destructive ops; renderer confirmation policy is test-enforced).
6. **Preview→Apply pairing**: the engine must model the token handoff (either a composite
   Preview+Apply node with a policy gate, or explicit token edge).
7. **Two service wrappers to add** (`AnsibleService`, `ContainerService`) + three new primitives
   (Run SSH Command, Wait For SSH Ready, Wait For Jenkins Build) + notification primitive.
8. **Jenkins trigger gap**: `trigger()` returns void — to await a build, capture next-build number
   via `status()` before/after trigger (or extend `JenkinsHttpManager.trigger` to return the queue item).
