# Runtime Topology Production Readiness Audit

**Audit date:** 23 July 2026  
**Audited version:** CloudForge 0.3.0, including commit `739c9a7`  
**Scope:** Runtime Topology Migration release candidate

## Decision

The Runtime Topology Migration is **code-level release ready** after the fixes
recorded in this document.

The audit did not trust the existing test result. It traced the Domain,
Application, port, adapter, IPC, persistence and renderer paths for Jenkins,
Nginx, SSL, Cloudflare, host/provider firewalls, preview/apply and target
lifecycle operations. The complete repository was then checked with:

```text
format:check   passed
typecheck      passed
lint           passed
tests          739 passed
build          passed
git diff check passed
```

This conclusion is deliberately limited to the code and automated test
environment. Before publishing the installer, run the live staging checklist at
the end of this document against a disposable VPS and test Cloudflare zone.
That is a release verification step, not a known code defect.

## Architectural conclusion

`VpsRuntimePlan` is the authoritative desired/runtime topology aggregate for a
saved VPS. Feature modules keep only the operational data they need to perform
their own job:

- Jenkins keeps job configuration and credentials.
- Nginx keeps site configuration and backups.
- SSL keeps certificates on the VPS.
- Cloudflare keeps DNS at Cloudflare.
- OCI keeps provider firewall rules.

Those systems are not duplicate Runtime Plans. Their application services
synchronize their topology projection into `VpsRuntimePlan` through the
existing `RuntimeTopologySynchronizer` port. Runtime reads and applies only the
central plan. No React component writes topology directly.

The migration uses the existing `Setting` table for plan persistence. It adds
no Prisma schema migration, deletes no existing row during application startup,
and creates no VPS changes for an existing target. A target without a stored
plan is represented as an empty `legacy` plan.

## Issues found and closed

### 1. Runtime Plan writes could lose concurrent updates

**Problem:** Loading a plan, comparing its version, and later writing it did not
make the comparison and write one atomic operation.

**Impact:** Two windows or two feature synchronizers could both accept the same
version and the last writer could silently erase the first writer's topology.

**Cause:** The repository contract did not carry the expected version through
to persistence.

**Fix:** `RuntimePlanStore.save` now receives `expectedVersion`.
`PrismaRuntimePlanStore` performs compare-and-swap against the exact current
serialized row. First creation also handles the unique-key race. Feature
synchronizers retry a genuine conflict against the newest plan instead of
forcing a stale snapshot.

**Compatibility:** The plan is still stored in the same `Setting` key and JSON
shape. No migration is required.

### 2. Corrupt plan rows failed open

**Problem:** A malformed or target-mismatched plan row could be interpreted as
if no valid plan existed.

**Impact:** A corrupt managed plan could appear as an empty legacy plan, hiding
the persistence problem.

**Cause:** Repository deserialization did not distinguish absence from invalid
stored data strongly enough.

**Fix:** The repository now fails closed with a persistence error for malformed
JSON, invalid plan data or a mismatched target ID.

**Compatibility:** A genuinely absent row still returns the empty legacy plan.

### 3. Preview approval could be reused or applied to a different snapshot

**Problem:** Preview/apply needed stronger guarantees around concurrency,
single-use authorization and the exact plan passed to the adapter.

**Impact:** Concurrent Apply requests or a topology change during Apply could
execute work not represented by the approved preview.

**Cause:** The previous flow could reload state independently and retained an
approval longer than necessary.

**Fix:**

- Preview fingerprints include plan version, operations, blockers and removal
  options.
- Apply re-inspects live state and re-derives the change.
- A stale fingerprint is rejected.
- The token is consumed before external mutation and is single use.
- A per-target Apply guard rejects concurrent execution.
- The exact plan used to derive the approved operation list is passed to the
  applier.
- Destructive operations still require exact resource-name confirmation.

**Compatibility:** The public Preview then Apply workflow is unchanged.

### 4. Equivalent discovery ordering invalidated previews

**Problem:** Feature APIs may return the same resources in a different order.
The plan comparison treated order as topology.

**Impact:** Read-only refreshes could increment the plan version and invalidate
a legitimate preview.

**Cause:** Semantic equality used direct JSON array order.

**Fix:** Topology is canonicalized only for equality comparison. Collection
order, observation timestamps and persistence metadata no longer create a new
version when the actual topology is unchanged.

**Compatibility:** Stored ordering and the plan payload are unchanged.

### 5. Runtime Apply could partially mutate before detecting invalid input

**Problem:** The SSH applier compiled and ran operations incrementally.

**Impact:** A deterministic error in a later operation could be discovered only
after an earlier valid operation changed the VPS.

**Cause:** Validation and shell generation happened inside the execution loop.

**Fix:** The full operation batch is compiled before opening SSH or making any
remote change. Any invalid operation rejects the batch before mutation.

**Compatibility:** Valid operation execution and streamed progress events are
unchanged.

An SSH/network failure can still happen after earlier operations succeeded.
That is an unavoidable external partial-failure boundary. Operations are
idempotent, the preview token is spent, the failure is reported, and the user
must inspect and preview the remaining difference before retrying.

### 6. Jenkins target moves left topology on the old VPS

**Problem:** Updating a saved pipeline to use another target synchronized the
new target but did not remove the Runtime Application from the former target.

**Impact:** The old VPS reported a ghost application, service and port.

**Cause:** Update synchronization used only the new record.

**Fix:** Jenkins now synchronizes the new target and removes the previous
application when `targetId` changes. Normal update, deletion and lazy list
repair remain idempotent.

**Compatibility:** Existing pipeline records and Jenkins jobs are unchanged.

### 7. Nginx restore and advanced config save missed Runtime synchronization

**Problem:** Normal site writes synchronized routes, but backup restore and
advanced `nginx.conf` save paths did not refresh the Runtime projection.

**Impact:** Runtime could retain routes that no longer matched the restored or
edited Nginx configuration.

**Cause:** Those two workflows returned before calling the shared topology
synchronizer.

**Fix:** Both workflows re-read the resulting Nginx sites and replace the
Nginx-owned Runtime Routes after a successful operation.

**Compatibility:** Native and containerized Nginx continue through the same
`NginxService`, backup, validation, reload and rollback adapters.

### 8. SSL inspection could erase known HTTPS state on a transient Nginx error

**Problem:** If certificate inspection succeeded while Nginx inspection failed,
the synchronization could record HTTPS and redirect as disabled.

**Impact:** A temporary SSH/Nginx read failure looked like real topology drift.

**Cause:** Unknown state was collapsed to `false`.

**Fix:** Synchronization is skipped when the dependent Nginx state is
indeterminate. The last known Runtime state is preserved and an activity/log
entry explains the partial observation.

**Compatibility:** Successful inspection behaves as before.

### 9. SSL fingerprint changes and reload failures were accepted too early

**Problem:** A discovered replacement certificate could overwrite the expected
fingerprint, and renewal could accept a certificate even if Nginx failed to
reload it.

**Impact:** Unexpected replacement, failed activation or possible revocation
could be hidden as healthy.

**Cause:** Observation and acceptance used the same upsert path.

**Fix:**

- Discovery retains the accepted fingerprint.
- A different live fingerprint is recorded as `changed` with the observed
  fingerprint and produces drift.
- Explicit successful issue/renew accepts the new fingerprint.
- A failed Nginx reload does not accept it, so the next inspection still
  reports drift.
- Missing certificates remain Runtime resources with `missing` status.

**Compatibility:** Certificate files, issue/renew commands and existing
certificate records are unchanged.

CloudForge has no explicit certificate revocation command in this release.
External revocation/removal is represented by missing/changed state on the next
inspection. Adding a revocation workflow would be a new feature and was
therefore outside this audit.

### 10. Cloudflare record deletion and target movement were not fully visible

**Problem:** Replacing the observed DNS set could simply remove a previously
managed Runtime DNS resource. A record moved to another VPS could also remain
associated with the old target.

**Impact:** Runtime could not distinguish “never managed” from “managed but now
missing,” and the old VPS could claim a DNS record that no longer resolved to
it.

**Cause:** Reconciliation rebuilt only the currently matching records.

**Fix:**

- Missing CloudForge-owned records remain with `missing` status.
- Moved records report an error on the old target and active state on the new
  target.
- Explicit upsert removes the same source record from other target plans.
- Explicit deletion removes it from every relevant target.
- Target resolution uses the saved target catalog and current record content.

**Compatibility:** Foreign records remain foreign. CloudForge neither adopts
nor rewrites a record without its ownership marker.

Cross-target DNS reconciliation necessarily updates multiple plan rows. The
existing repository has no cross-plan transaction port. Compare-and-swap,
idempotent reconciliation and subsequent refresh repair a process interruption
without silently overwriting either plan.

### 11. Host firewall inspection misread nftables DROP rules

**Problem:** A raw nftables rule mentioning a port could be classified as open
even if its verdict was `drop` or `reject`.

**Impact:** Runtime Connectivity could claim that a blocked port was reachable.

**Cause:** The probe matched the port without evaluating the rule verdict.

**Fix:** Port-specific and policy-level `drop`/`reject` are handled
conservatively as closed; matching `accept` is open. Unknown/unreadable state is
kept indeterminate rather than reported as reachable.

**Compatibility:** UFW, firewalld and iptables detection continue through the
same shared host-firewall builder.

### 12. Raw nftables changes were not persistent

**Problem:** The open-firewall script added a live nftables rule while claiming
it was persistent.

**Impact:** A reboot could silently close a port CloudForge had reported as
opened.

**Cause:** The current ruleset was not safely written to the service
configuration.

**Fix:** The script snapshots the rules, validates the generated ruleset with
`nft -c`, writes `/etc/nftables.conf`, and enables the nftables service through
systemd or OpenRC. Persistence failure is now a real failure.

**Compatibility:** Existing rules are preserved; the operation remains
additive and idempotent.

### 13. Deleted targets could leave orphan Runtime Plans

**Problem:** Runtime plans live in the generic `Setting` table and have no
foreign key to `VpsTarget`.

**Impact:** Manual deletion, project cleanup or managed-resource cleanup could
leave stale topology records.

**Cause:** Target lifecycle paths deleted only the target repository row.

**Fix:** Every target-removal workflow now also deletes the corresponding
Runtime Plan: manual removal, project removal, resource removal and
reconciliation of resources/projects no longer present.

**Compatibility:** Plan deletion does not connect to or modify the VPS.

The target repository and generic Setting repository do not expose a shared
database transaction. A database failure between those two deletions could
leave an unreachable orphan Setting. UUID target IDs are not reused, and the
next cleanup can remove it; it cannot be inherited by another target.

### 14. Windows could not execute the real shell-syntax release tests

**Problem:** Generated shell tests directly invoked `sh`, which is commonly not
on the PowerShell PATH even when Git for Windows provides it.

**Impact:** The full suite produced platform-only failures and could tempt a
release to skip the tests that validate firewall, Ansible and Nginx scripts.

**Cause:** Each test file implemented its own shell lookup.

**Fix:** The deployment tests share one resolver that uses PATH or the standard
Git for Windows shell locations. Generated scripts are still validated by a
real `sh -n`; no assertion was weakened.

**Compatibility:** Linux and macOS continue to resolve `sh` normally.

## Subsystem verification

### Jenkins synchronization

Verified:

- Save creates or updates the Runtime Application and host service.
- Delete removes the Runtime Application and cleans orphan route endpoints.
- Moving a pipeline between targets removes old topology.
- Jenkins ownership is copied to Runtime source metadata.
- `HOST_PORT` is authoritative, loopback-bound, and no longer a run-time
  override.
- repository URL, branch/ref and Jenkinsfile/deployment mode are synchronized.
- exposure is synchronized as `host-loopback`.
- listing saved pipelines repairs older records that predate synchronization.

The Jenkins orchestration spans Jenkins, credentials, optional Cloudflare,
optional Nginx and Runtime. Those external systems cannot share one transaction.
All steps are idempotent and the saved pipeline list repairs Runtime after an
interrupted process.

### Nginx synchronization

Verified:

- Create, update, delete, restore and advanced config save synchronize routes.
- Domain, path, upstream host/port, WebSocket, TLS and redirect are represented.
- Every route resolves to a Runtime Application and service.
- CloudForge ownership is preserved.
- Foreign sites are observable but not claimed.
- Native and containerized Nginx use the same Application service.
- Adapter backup, syntax validation, reload and rollback remain in force.

### SSL synchronization

Verified:

- Certificate status, authority, expiry, days remaining, fingerprint, HTTPS and
  redirect state are represented.
- Issue and renew synchronize only after successful activation.
- Missing and changed fingerprints produce drift.
- Transient dependent-state errors preserve the last known state.
- Renewal and Nginx reload failures are logged and remain visible as drift.

### Cloudflare synchronization

Verified:

- CloudForge-owned A/AAAA topology is mapped to a saved VPS.
- Create, edit, delete, refresh and target movement reconcile Runtime.
- Foreign records are never claimed or repointed.
- Missing/moved records produce drift.
- Target resolution is based on the record target and the saved VPS catalog.

### Firewall synchronization

Verified:

- Runtime requirements are derived from the central plan and installed native
  service profiles.
- Runtime Connectivity reads the current host firewall through SSH.
- Provider connectivity uses the current provider adapter, not a copied Runtime
  rule list.
- OCI Security Lists are read through the provider-independent firewall port.
- UFW, firewalld, nftables and iptables share one detection/opening builder.
- Unknown firewall state is indeterminate, never optimistically open.
- Opening ports is additive, validated and idempotent.

The legacy `providerRules` IPC input remains accepted for older renderer
clients, but the current application loads live provider state through the main
process adapter.

### Drift coverage

Verified drift for:

- owned containers, networks and volumes;
- adopted/foreign ownership differences;
- Runtime Applications, services and Nginx Routes;
- missing or changed certificates;
- missing, moved or erroneous DNS records;
- host and provider firewall connectivity.

A foreign resource that CloudForge never owned is intentionally not drift.
That rule is fundamental to safe legacy adoption.

### IPC and secret boundaries

All Runtime channels were audited:

```text
runtime:getPlan
runtime:savePlan
runtime:validatePlan
runtime:setMode
runtime:drift
runtime:adopt
runtime:release
runtime:connectivity
runtime:openFirewall
runtime:preview
runtime:apply
runtime:inspect
runtime:log
```

The renderer sends identifiers, validated plans, preview tokens, options and
confirmation names. The main process resolves the target, pinned host key,
encrypted SSH material and provider credentials. Secret material is never
returned to the renderer.

Electron remains configured with context isolation enabled, Node integration
disabled and renderer sandboxing enabled. Runtime Apply progress crosses only
the typed event channel.

### Database and upgrade compatibility

- No Prisma schema change was introduced.
- No startup migration rewrites Runtime data.
- Existing projects receive no stored plan automatically.
- Missing plans load as `legacy`.
- `legacy` mode is read-only and cannot Apply or open host-firewall ports.
- Merely opening or inspecting Runtime makes no VPS change.
- Deleting a target removes only local topology intent; it does not contact the
  VPS.
- Existing operational repositories remain compatible.

## Production safety conclusions

| Concern                  | Result                                                                     |
| ------------------------ | -------------------------------------------------------------------------- |
| Lost updates             | Atomic compare-and-swap plus bounded conflict retry                        |
| Concurrent Apply         | One in-flight Apply per target and a single-use token                      |
| Stale preview            | Live re-inspection and exact change fingerprint                            |
| Destructive operation    | Exact resource-name confirmation                                           |
| Deterministic bad batch  | Entire batch compiled before SSH                                           |
| External partial failure | Reported, token consumed, idempotent retry after a new preview             |
| Nginx broken config      | Backup, syntax validation, reload check and rollback                       |
| SSL activation failure   | New fingerprint is not accepted                                            |
| Foreign DNS/container    | Never adopted or mutated implicitly                                        |
| Firewall uncertainty     | Reported indeterminate, never assumed reachable                            |
| Resource leak            | Runtime plan removed across all saved-target deletion paths                |
| Read-only refresh churn  | Semantic topology equality ignores ordering, timestamps and store metadata |

## Mandatory live staging checklist

Use a disposable target. Existing production targets must remain `legacy`
during this verification.

1. Capture `docker ps`, Docker networks and volumes before opening Runtime.
2. Start CloudForge 0.3.0 and inspect the target in `legacy` mode.
3. Confirm there is no Docker/Nginx/firewall difference after inspection.
4. Save one existing native Nginx site; verify one CloudForge config file,
   successful `nginx -t`, correct route and unchanged unrelated sites.
5. Repeat for containerized Nginx if used.
6. Refresh SSL; verify expiry, fingerprint, HTTPS and redirect.
7. Temporarily replace a staging certificate and confirm `changed` drift before
   explicit acceptance.
8. Refresh Cloudflare; confirm a foreign record is untouched and a managed
   missing record reports drift.
9. Verify Runtime Connectivity against one allowed and one blocked port.
10. On an nftables staging host, open a required port, reboot, and confirm the
    rule persists.
11. Switch the disposable target to `hybrid`, adopt one harmless resource,
    Preview and Apply.
12. Change the VPS after Preview and verify stale Apply is rejected.
13. Send two Apply requests and verify only one can run.
14. Delete the disposable target in CloudForge and verify the VPS itself was
    not contacted or modified.

## Final statement

No parallel topology system was introduced. The fixes extend the existing
Domain model, Application services, ports, adapters, repositories, typed IPC,
Activity history and Result-based error flow. Existing targets remain safe by
default, while synchronized feature state now converges on the single
`VpsRuntimePlan` aggregate.
