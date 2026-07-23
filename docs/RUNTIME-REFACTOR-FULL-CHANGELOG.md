# Runtime Refactor — Complete Before/After Change Record

## Purpose of this document

This document explains the complete `runtime-refactor` branch in a form that can
be given to another person or AI for further explanation.

It does not only list modified files. For every important change it explains:

1. What CloudForge did before the branch.
2. What was wrong, unsafe, duplicated, or missing.
3. What the branch implemented.
4. What CloudForge does now.
5. What remains intentionally unsupported or incomplete.
6. How the behavior can be verified.

This is a change record, not a promise that every feature has been tested
against a real production VPS. Automated tests cover the code paths, but the
live migration checks near the end of this document are still required.

## Branch identity and measured scope

- Branch: `runtime-refactor`
- Compared against: `main`
- Merge base: `e45a3307ca7f0f84daa6794e6443cb7be020de94`
  (`v0.2.36`)
- Commits after the merge base: 10
- Files changed: 92
- Lines added: 15,463
- Lines removed: 1,092
- Database schema migration: none

Some earlier documents report 9 commits, 91 files, and
14,545 additions/1,053 deletions. Those numbers were captured before the final
documentation commit and are no longer the exact branch totals.

## Executive summary

Before this branch, each CloudForge feature understood only its own fragment of
a VPS:

- Ansible knew which native services it installed.
- Jenkins knew which application port a pipeline used.
- Nginx knew which upstream it proxied.
- Containers knew which Docker objects were running.
- Firewall knew some cloud or host rules.
- Cloudflare knew DNS records.

There was no shared model capable of answering:

- Which resources belong to CloudForge?
- Which resources existed before CloudForge?
- Which network should connect two containers?
- Can traffic actually reach an application through both host and provider
  firewalls?
- Is CloudForge allowed to modify or delete a resource?
- Did the VPS change after a user reviewed a preview?

The branch introduces a central runtime domain named `VpsRuntimePlan`. It adds
ownership, adoption, drift detection, connectivity analysis, preview/apply
tokens, and guarded topology operations.

The branch also fixes several independent production problems in Nginx,
Cloudflare, Jenkins, Ansible, firewall handling, containers, and SSL.

Important qualification: the runtime domain is now a strong foundation, but it
is not yet automatically populated by every CloudForge feature. Jenkins,
Nginx, SSL, and Cloudflare still retain their existing storage and workflows.
They received targeted fixes, but they do not yet all write their topology into
`VpsRuntimePlan`.

## Commit sequence

| Commit    | Purpose                                                      |
| --------- | ------------------------------------------------------------ |
| `f72bc8c` | Introduced the unified runtime model and phases 0–5a         |
| `3345554` | Added cloud security-list information to connectivity checks |
| `e1852b1` | Derived Nginx upstream kind instead of trusting stored input |
| `8f53964` | Unified firewall behavior and Ansible service declarations   |
| `898fd84` | Made Jenkins `HOST_PORT` CloudForge-owned                    |
| `aa74545` | Prevented Cloudflare from repointing foreign DNS records     |
| `19fc483` | Added the VPS Runtime page                                   |
| `7028f31` | Added runtime model and migration documentation              |
| `8dfc3ac` | Added containerized Nginx editing and safe rollback          |
| `5918fdd` | Added the detailed phase-by-phase development record         |

## Terminology introduced by the branch

### Runtime plan

A `VpsRuntimePlan` is CloudForge's declared view of the topology associated
with one saved `VpsTarget`. It can describe:

- Docker networks.
- Application containers.
- Native services.
- Reverse-proxy routes.
- Network attachments and aliases.
- Explicit adoption records.
- Runtime management mode.

### Runtime modes

| Mode      | Meaning                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `legacy`  | Inspect only. Existing targets default to this mode. Runtime apply and host firewall changes are not used to manage the VPS.  |
| `hybrid`  | CloudForge manages only resources explicitly declared or adopted in the runtime plan.                                         |
| `managed` | CloudForge attempts to keep the owned/adopted topology aligned with the plan, within the intentionally limited operation set. |

### Ownership states

| State       | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `managed`   | CloudForge created or explicitly owns the resource.                              |
| `adopted`   | The user explicitly told CloudForge to include an existing resource in its plan. |
| `legacy`    | The resource belongs to an existing setup that predates runtime management.      |
| `unmanaged` | The resource exists but CloudForge has no authority to change it.                |

The governing rule is:

> A resource CloudForge does not own is never treated as actionable drift.

### Exposure levels

| Exposure        | Intended behavior                                                                    |
| --------------- | ------------------------------------------------------------------------------------ |
| `internal`      | Available only within its Docker topology.                                           |
| `proxy-only`    | Reached through the configured reverse proxy, not directly from the internet.        |
| `host-loopback` | Published only on `127.0.0.1` and intended for a native host proxy.                  |
| `direct`        | Published directly on a host port and may require host and provider firewall access. |

## Detailed change index

1. Phase 0 — Existing safety bugs fixed before runtime unification.
2. Phase 1 — `VpsRuntimePlan` domain model and validation.
3. Phase 2 — Ownership, inspection, drift, persistence, and adoption.
4. Phase 3 — Operations, preview tokens, guarded apply, and deletion.
5. Phase 4 — Unified host/provider firewall connectivity.
6. Phase 5a — Reverse-proxy route reachability.
7. Phase 5b — Containerized Nginx editing and rollback.
8. Phase 6 — Ansible service declarations and firewall consolidation.
9. Phase 7 — Jenkins `HOST_PORT` ownership.
10. Phase 8 — VPS Runtime page.
11. Phase 9 — Cloudflare DNS ownership.
12. Container IPC and application-layer security.
13. SSL behavior after the refactor.
14. Database and persistence changes.
15. Typed IPC changes.
16. What remains incomplete.
17. Test status and Windows portability.
18. Required live migration verification.

---

## Phase 0 — Safety bugs fixed before runtime unification

Phase 0 corrected existing behavior that would have made the new runtime layer
unsafe to build upon.

### 0.1 Nginx had multiple configuration writers

#### Before

Ansible and the Nginx Manager could generate site files using different:

- Filenames.
- Metadata comments.
- Rendering assumptions.
- Cleanup behavior.

The same domain could therefore have two active `server` blocks in
`/etc/nginx/conf.d/`.

#### Problem

Nginx could select an unexpected server block. Editing a site from one feature
did not guarantee that the configuration generated by another feature was
removed.

#### Implementation

The branch introduced shared Nginx site-file naming and metadata utilities.
Readers accept legacy formats, while new writes use the unified CloudForge
format. Saving a site transactionally cleans up the obsolete legacy filename.

#### Now

A CloudForge-managed domain should have one canonical
`cloudforge-*.conf` file.

#### Verify

Save one existing domain in Nginx Manager, then run:

```bash
ls -la /etc/nginx/conf.d/
grep -R "server_name app.example.com" /etc/nginx/conf.d/
```

Exactly one active CloudForge configuration should contain the domain.

### 0.2 Enabling SSL could remove advanced proxy behavior

#### Before

The SSL feature had its own Nginx renderer. It did not preserve every property
supported by the normal Nginx site renderer.

#### Problem

Issuing or applying a certificate could silently remove:

- WebSocket locations.
- Custom headers.
- Extra location blocks.
- Proxy timeouts.
- Client maximum body size.
- Compression.
- Cache settings.
- Custom snippets.

The certificate could succeed while the application stopped working correctly.

#### Implementation

HTTP and HTTPS rendering now share the same complete proxy body. SSL augments
the existing site with certificate and redirect behavior instead of rebuilding
a reduced version of the site.

#### Now

Applying SSL should preserve the application's routing and proxy behavior.

#### Verify

Compare the site before and after enabling SSL and run:

```bash
sudo nginx -t
grep -n "location\\|proxy_set_header\\|proxy_read_timeout" \
  /etc/nginx/conf.d/cloudforge-*.conf
```

### 0.3 The renderer selected SSH identity information

#### Before

Some container IPC calls accepted raw host information and host-key identity
data from React.

#### Problem

The renderer could select or send security-sensitive connection information.
This bypassed the intended boundary where the main process owns encrypted
credentials and trusted SSH host fingerprints.

#### Implementation

Container operations now receive a saved `targetId`. The main process resolves:

- Host.
- Port.
- SSH username.
- Encrypted SSH credential.
- Trusted host fingerprint.

#### Now

React selects a saved VPS target but does not construct the privileged SSH
connection.

### 0.4 Certificate management duplicated firewall logic

#### Before

Certificate issuance contained a private copy of host firewall commands for
ports 80 and 443.

#### Problem

The copy could drift from Ansible, runtime, and other firewall behavior.

#### Implementation

Certificate management now uses the shared host firewall fragment.

#### Now

The same backend detection and port-opening rules are reused.

---

## Phase 1 — `VpsRuntimePlan` domain model and validation

### Before

No single domain object represented the complete topology of a VPS.

Each module maintained independent facts:

- Jenkins stored application parameters.
- Nginx stored sites and upstreams.
- Ansible knew installed profiles.
- Containers listed Docker state.
- Firewall loaded rules independently.

### Problem

CloudForge could not validate relationships across features. For example, it
could not reliably determine:

- Whether a container proxy shared a Docker network with its upstream.
- Whether a native proxy could reach a container on loopback.
- Whether two declarations conflicted.
- Whether labels accidentally contained secrets.
- Whether an adoption record was duplicated.

### Implementation

The branch introduced `VpsRuntimePlan`, including:

- Plan version and schema version.
- Target identity.
- Runtime mode.
- Reverse-proxy mode.
- Networks.
- Applications.
- Native services.
- Routes.
- Attachments and aliases.
- Adoption records.

It also introduced domain validation for:

- Safe Docker names.
- Valid port numbers and ranges.
- Duplicate resource names.
- Duplicate adoption records.
- Missing networks.
- Invalid route/upstream combinations.
- Proxy-mode reachability.
- Secret-looking values in Docker labels.
- Conflicting network attachments.

### Now

Invalid topology can be rejected before any remote operation begins.

### Important limitation

The model exists, but the current renderer does not provide a complete visual
editor for every part of the plan. Existing Jenkins, Nginx, SSL, and Cloudflare
records are not automatically converted into this model.

---

## Phase 2 — Ownership, live inspection, drift, persistence, and adoption

### 2.1 Live Docker inspection

#### Before

Container discovery relied heavily on `docker ps`, which provides a useful
summary but not a complete topology.

#### Problem

CloudForge lacked reliable information about:

- Docker labels.
- Complete network attachments.
- Network aliases.
- Bind mounts.
- Restart policy.
- Exact port bindings.
- Container identity across states.

#### Implementation

The runtime inspector uses `docker inspect` and Docker network inspection.

#### Now

Runtime comparisons use detailed observed state rather than only the process
list.

### 2.2 Ownership-aware drift

#### Before

There was no shared drift definition for VPS runtime resources.

#### Problem

A naïve drift implementation could interpret every unfamiliar container or
network as something CloudForge should remove or replace.

#### Implementation

Drift calculation is a pure domain operation and considers ownership.

- Managed/adopted resources can produce actionable drift.
- Unmanaged resources are visible but are not actionable drift.
- Legacy mode reports an intentionally non-management result.
- Docker-unavailable is reported as one runtime inspection error rather than
  generating misleading per-resource drift.

#### Now

CloudForge can show differences without claiming authority over foreign
resources.

### 2.3 Runtime plan persistence

#### Before

There was no persisted runtime plan.

#### Implementation

Plans are stored as JSON in the existing `Setting` table:

```text
runtime-plan:<targetId>
```

The service:

- Limits a serialized plan to 512 KB.
- Forces the target ID to match the selected target.
- Uses optimistic plan-version checks.
- Validates before saving.
- Uses schema version 1.

#### Now

Runtime state persists without a Prisma schema migration.

### 2.4 Adoption

#### Before

CloudForge had no explicit operation for claiming an existing Docker resource.

#### Problem

Automatically stamping ownership labels would require recreating containers,
because Docker container labels cannot be changed in place. Docker networks
also have no general update command for rewriting all relevant ownership data.

#### Implementation

Adoption:

1. Inspects the live resource.
2. Confirms that it exists.
3. Writes an adoption record into the plan.
4. Does not mutate the VPS.

#### Now

The user can explicitly authorize management without silently recreating the
resource.

#### Important consequence

Adoption is a CloudForge plan decision. It does not physically relabel an
already-running container.

---

## Phase 3 — Operations, preview tokens, guarded apply, and deletion

### 3.1 Runtime operations

#### Before

There was no common operation model or risk classification for VPS topology
changes.

#### Implementation

The branch introduced operations with risk levels:

- `safe`
- `disruptive`
- `destructive`
- `manual`

Executable runtime operations are deliberately limited to topology:

- Create a CloudForge-managed Docker network.
- Attach a container to a network.
- Detach a container from a network.
- Reconnect a container to update aliases.
- Remove an empty CloudForge-owned network.

#### Explicitly not implemented

Runtime Apply does not:

- Create an application container.
- Rebuild an image.
- Restart an application.
- Redeploy a Jenkins workload.
- Delete an application container.
- Delete Docker volumes.
- Remove a non-empty network with force.

Container/image/restart differences are returned as manual instructions to
redeploy through the existing pipeline or container workflow.

### 3.2 Preview token

#### Before

Preview and Apply were not bound to the same live runtime state.

#### Problem

The user could review one result, the VPS could change, and Apply could execute
against different state.

#### Implementation

Preview:

1. Reads the live VPS.
2. Re-derives drift and operations.
3. Includes blockers and deletion options.
4. Generates a fingerprint.
5. Stores a one-use token in the main process.

Apply:

1. Reads the VPS again.
2. Re-derives the fingerprint.
3. Rejects a missing, stale, or mismatched token.
4. Rejects unresolved blockers.
5. Requires exact resource-name confirmation for destructive operations.

#### Now

Apply cannot blindly trust a preview generated from stale live state.

### 3.3 Runtime plan deletion

#### Before

There was no runtime plan to delete.

#### Implementation

Deleting a runtime plan removes only its `Setting` record.

#### Now

Deleting the plan does not delete containers, networks, applications, or VPS
resources.

---

## Phase 4 — Unified host/provider firewall connectivity

### 4.1 Host firewall detection

#### Before

Firewall behavior was copied into several features. Some copies recognized only
UFW, firewalld, or iptables.

#### Problem

On modern Linux distributions, nftables may be the actual firewall while the
`iptables` command is only a compatibility shim. CloudForge could:

- Open a rule through the wrong backend.
- Open nothing.
- Report success without verifying the result.
- Report an already-open port as closed.

#### Implementation

One host firewall implementation now recognizes:

1. UFW.
2. firewalld.
3. nftables.
4. iptables.
5. `none`.
6. `unknown`.

nftables is checked before iptables. After an opening operation, CloudForge
re-inspects the firewall instead of assuming success.

#### Now

Ansible, certificates, runtime connectivity, and the other migrated callers use
the same backend behavior.

### 4.2 Required ports

#### Before

Every feature decided independently which ports it needed.

#### Implementation

Runtime requirements merge:

- Reverse-proxy routes.
- Directly exposed services.
- Native services installed through Ansible.

Rules intentionally distinguish:

- Loopback ports, which do not need internet firewall rules.
- Direct ports, which may need host and provider rules.
- Port 80, required for HTTP traffic and HTTP-based ACME challenges.
- Port 443, which is not declared merely because Nginx exists; HTTPS must
  actually be configured.
- Port 22, which is excluded from automatic application requirements.

### 4.3 Provider firewall interpretation

#### Before

Cloud security-list information was not part of the runtime connectivity
verdict.

#### Implementation

Provider rules are read conservatively:

- Rule must be inbound.
- Protocol must cover the required traffic.
- CIDR must cover the intended source.
- Port range must cover the required port.
- Partially specified ranges are interpreted narrowly.

The narrow interpretation is intentional: incorrectly saying that a port is
open can make a user debug the application when the real problem is the cloud
firewall.

### 4.4 Combined connectivity verdict

A port can be classified using:

- Host firewall state.
- Provider firewall state.
- Exposure type.
- Whether provider information was supplied.

### Current UI limitation

The backend IPC accepts provider firewall rules, but the VPS Runtime page does
not automatically import rules previously loaded on the Firewall page.
Therefore the provider half can remain `unknown` in the Runtime page even when
the Firewall page knows the rules.

Runtime can open required host ports additively. There is no equivalent
close-port action exposed in the Runtime UI.

---

## Phase 5a — Reverse-proxy route reachability

### Before

Nginx routes and container topology were stored independently.

### Problem

A route could appear valid even though the proxy could not reach its upstream:

- Native Nginx cannot reach a container that has no host/loopback published
  port.
- Containerized Nginx cannot reach an application container unless they share
  a Docker network or use another valid reachable endpoint.

This commonly produced a `502 Bad Gateway` without explaining the topology
mistake.

### Implementation

Validation now depends on proxy mode.

#### Native/host Nginx

The upstream application must expose a host-reachable port, normally bound to
loopback:

```text
127.0.0.1:8001
```

#### Containerized Nginx

The proxy and application must share a declared Docker network, and the route
must use a reachable container alias/name and internal port.

### Derived `upstreamKind`

#### Before

The caller supplied `upstreamKind`, and CloudForge trusted the stored value.

#### Problem

The stored type could contradict the upstream:

- `127.0.0.1` described as a Docker container.
- A Docker service name described as a host IP.

#### Implementation

CloudForge derives the kind from the upstream host:

- IP addresses, `localhost`, and hostnames/FQDNs are host/IP upstreams.
- A valid single-label Docker service/container name is treated as a Docker
  upstream where appropriate.

#### Now

The description cannot silently contradict the actual endpoint.

---

## Phase 5b — Containerized Nginx editing and safe rollback

### Before

CloudForge could inspect some containerized Nginx state but could not safely
edit it.

The old rollback strategy for Nginx configuration used behavior equivalent to:

```bash
rm -rf /etc/nginx
```

### Problem

If `/etc/nginx` was bind-mounted into a container, deleting the directory could
leave the container attached to a deleted inode. Restoring a new directory at
the same path did not repair the already-mounted inode.

A failed configuration validation could therefore leave Nginx in a worse state
than before the attempted edit.

### Implementation

Containerized Nginx now supports:

- Command execution through `docker exec`.
- Configuration discovery.
- Site editing.
- `nginx -t`.
- Reload.
- Backup listing.
- Restore.

Before editing, CloudForge verifies that the expected host configuration
directory is genuinely mounted into the selected container by using a probe
file visible from both sides.

Rollback preserves the original directory inode:

```bash
find /etc/nginx -mindepth 1 -delete
```

It then extracts the backup contents back into that same directory.

### Now

Failed validation restores the previous configuration without invalidating a
bind mount.

### Native/container detection

If both native and containerized Nginx appear to exist, native Nginx currently
wins selection.

---

## Phase 6 — Ansible service declarations and firewall consolidation

### Before

Ansible playbooks independently embedded firewall commands. Service ports were
implicit in the playbook rather than declared as reusable requirements.

### Problem

- Firewall shell logic drifted between profiles.
- nftables behavior was missing.
- Runtime could not ask Ansible which ports a profile required.
- A profile could install a service but connectivity reporting might not know
  its port.

### Implementation

Ansible profiles now declare native service requirements.

Examples include:

- Dockhand and its configured port.
- Portainer and its configured port.
- Jenkins and its configured port.
- Nginx port 80.
- Docker Engine with no public application port requirement.

The profile's firewall task uses the shared host firewall implementation.

The generated shell is extracted from YAML during tests and checked as shell
syntax.

### Why Nginx declares port 80 but not automatically 443

Installing Nginx proves that an HTTP service can exist. It does not prove that a
certificate and HTTPS server block exist. Declaring 443 merely because Nginx is
installed would overstate actual reachability.

### Now

Ansible and runtime connectivity share a common definition of required native
service ports.

---

## Phase 7 — Jenkins `HOST_PORT` ownership

### Before

When CloudForge configured a domain for a Jenkins pipeline:

- It added `HOST_PORT`.
- The field could still be modified at run time.
- Status synchronization did not always restore the configured port.
- Turning domain management off could leave the parameter behind.
- CloudForge did not distinguish its parameter from a pre-existing user
  parameter with the same name.

### Problem

Nginx forwards the application domain to this exact port. A modified or stale
value made Nginx proxy to the wrong endpoint, producing a `502`.

Allowing a run-time override suggested flexibility that did not actually exist:
the Nginx site remained configured for the original port.

### Implementation

CloudForge records whether it owns the Jenkins parameter.

When CloudForge owns `HOST_PORT`:

- Save writes the configured application port.
- Trigger ignores a caller-supplied override.
- Status/synchronization reasserts the configured value.
- Disabling domain management removes the parameter.

When a user already created `HOST_PORT`, CloudForge does not silently claim or
remove that user-owned parameter.

The encrypted environment credential parameter receives similar
CloudForge-managed treatment where applicable.

### Now

Jenkins, Nginx, and the CloudForge pipeline form use one stable application
port.

### Behavior change users will notice

`HOST_PORT` can no longer be changed from the run form. This is intentional,
because changing only the Jenkins parameter without changing Nginx never
produced a valid deployment.

---

## Phase 8 — VPS Runtime page

### Before

There was no page showing the declared and observed topology of a saved VPS.

### Implementation

A new sidebar module was added:

```text
Manage
  VPS Runtime
```

The page supports:

- Selecting a saved `VpsTarget`.
- Reading or changing runtime mode.
- Inspecting the VPS.
- Displaying observed containers and networks.
- Comparing runtime plan and observed state.
- Displaying drift and blockers.
- Adopting an existing resource.
- Releasing an adoption.
- Displaying required-port connectivity.
- Opening missing host firewall ports additively.
- Previewing operations.
- Applying a valid preview.

### Deliberate absences

The page does not:

- Provide an interactive terminal.
- Display or accept SSH private keys.
- Accept raw VPS passwords.
- Poll continuously.
- Create/redeploy application containers.
- Force-remove Docker networks.
- Delete volumes.
- Automatically close host firewall ports.

The renderer sends target IDs and user intent. The main process resolves
credentials and performs privileged work.

### Existing-target behavior

Every target without a stored runtime plan resolves to an empty `legacy` plan.
Therefore installing this branch should not begin managing existing VPS
topology automatically.

---

## Phase 9 — Cloudflare DNS ownership

### Before

CloudForge searched for a DNS record at the requested hostname and could update
it to point at the selected VPS. It then marked the result as CloudForge
managed.

### Problem

A manually created or externally managed record could be repointed without a
safe ownership decision.

DNS changes have no automatic transactional rollback. Repointing a production
record can immediately move traffic away from the real service.

### Implementation

CloudForge-owned records use this comment marker:

```text
Managed by CloudForge
```

The ensure algorithm distinguishes:

#### Managed existing record

CloudForge may update it in place because the marker proves ownership.

#### Foreign A/AAAA record pointing elsewhere

CloudForge refuses to save and reports a conflict. It does not modify the
record.

#### Foreign A/AAAA record already pointing to the selected VPS

CloudForge leaves it untouched and does not stamp its ownership marker onto it.
It may wait for propagation if requested.

#### Existing CNAME at the hostname

CloudForge does not treat it as an equivalent owned A record and does not
silently convert it.

### Behavior change users will notice

A pipeline whose domain was configured manually may now fail to save if the
existing record points somewhere else. The user must deliberately update or
remove that record through Cloudflare management before CloudForge can create
its own managed record.

---

## Container IPC and application-layer security

### Before

Container IPC handlers called lower-level container management directly and
accepted more connection information from the renderer.

### Problem

This weakened the Clean Architecture boundary and allowed React to participate
in security-sensitive SSH selection.

### Implementation

A `ContainerService` application service now mediates container use cases.

It:

- Resolves a `VpsTarget` through the target repository.
- Resolves the encrypted SSH credential in the main process.
- Uses the saved trusted host fingerprint.
- Validates container names and IDs.
- Limits Docker Compose payload sizes.
- Records mutation activity.
- Returns application-level results/errors through typed IPC.

Container channels now primarily receive `targetId` plus operation-specific
intent.

### Now

The renderer does not need access to private keys, passwords, or raw trusted
identity material to list or operate containers.

---

## SSL behavior after the refactor

### Before

SSL configuration and Nginx site configuration could diverge. Certificate
application could use a reduced proxy template.

### Implementation

- SSL reuses the shared Nginx renderer.
- Host firewall preparation uses the shared implementation.
- Existing routes and WebSocket behavior are preserved.
- Certificate inventory and expiry behavior remain part of the existing SSL
  module, not the runtime plan.

### Now

SSL changes are less likely to damage an application's Nginx behavior.

### Important limitation

Certificate state is not written into `VpsRuntimePlan`. The SSL module remains
its own application workflow and data source.

---

## Database and persistence changes

### What changed

A Prisma-backed runtime plan store was added.

### What did not change

- No Prisma model was added.
- No migration directory was added.
- No existing table must be transformed.
- Existing projects, targets, credentials, pipelines, and sites are not
  migrated into runtime plans.

### Storage format

The existing `Setting` table contains one JSON value per target:

```text
key   = runtime-plan:<targetId>
value = serialized VpsRuntimePlan
```

### Upgrade behavior

If the setting is absent, CloudForge constructs an empty version-0 legacy plan
in memory. It does not write or apply a managed plan automatically.

---

## Typed IPC changes

The branch added runtime channels for:

- `runtime:inspect`
- `runtime:getPlan`
- `runtime:savePlan`
- `runtime:validatePlan`
- `runtime:setMode`
- `runtime:drift`
- `runtime:adopt`
- `runtime:release`
- `runtime:connectivity`
- `runtime:openFirewall`
- `runtime:preview`
- `runtime:apply`
- `runtime:log`

Container channels were also changed to use saved target identities.

### Security boundary

Runtime operations are validated in the application/domain layer. The IPC
contract is TypeScript-typed.

### Remaining IPC limitation

The project still does not have one generic runtime schema validator for every
IPC payload, nor one global sender-origin validator for every channel. The new
runtime service validates its critical values, but compile-time typing alone
does not validate arbitrary JavaScript at runtime.

---

## What the branch does not yet unify

This section is important because the phrase "one authoritative runtime model"
can otherwise sound more complete than the implementation currently is.

### Jenkins

Jenkins received `HOST_PORT` ownership fixes, but saving a Jenkins pipeline does
not automatically add that application and its port to `VpsRuntimePlan`.

### Nginx

Nginx received unified rendering, reachability validation utilities, and safe
container editing. Existing Nginx sites are not automatically converted into
runtime plan routes.

### SSL

SSL uses the safer shared Nginx/firewall behavior, but certificates are not
declared in the runtime plan.

### Cloudflare

Cloudflare received DNS ownership protection, but DNS records are not part of
the runtime plan.

### Firewall page

The Runtime backend can analyze supplied provider rules, but the Runtime page
does not automatically consume the rules loaded by the dedicated Firewall
page.

### Runtime plan editing

`runtime:savePlan` exists in typed IPC and the application layer supports
saving. The renderer currently has no complete form for authoring all networks,
applications, services, routes, aliases, and attachments.

### Synchronization conclusion

The branch creates the common domain and safe operations needed for future
unification. It does not yet replace all existing module repositories with the
runtime plan.

---

## Direct before/after summary

| Area                           | Before this branch                         | After this branch                         |
| ------------------------------ | ------------------------------------------ | ----------------------------------------- |
| VPS topology                   | No shared model                            | `VpsRuntimePlan` domain exists            |
| Existing VPS upgrade           | No runtime mode                            | Defaults to read-only `legacy`            |
| Ownership                      | Inconsistent/feature-specific              | Managed, adopted, legacy, unmanaged       |
| Adoption                       | Not available                              | Explicit plan-only adoption               |
| Drift                          | No shared runtime drift                    | Ownership-aware pure drift calculation    |
| Preview/apply                  | Not bound to identical live state          | Fingerprinted one-use preview token       |
| Destructive runtime operations | No common confirmation model               | Exact resource name required              |
| Application containers         | Managed through separate features          | Runtime does not recreate/delete them     |
| Docker inspection              | Primarily summary/list state               | Detailed `docker inspect` topology        |
| Container SSH IPC              | Renderer supplied more connection identity | Main process resolves saved target        |
| Nginx writers                  | Could generate duplicate/conflicting files | Unified canonical site files              |
| SSL + Nginx                    | SSL could remove advanced proxy behavior   | Shared full site rendering                |
| Containerized Nginx            | Editing unsupported/unsafe                 | `docker exec`, mount proof, safe rollback |
| Nginx rollback                 | Could remove bind-mounted directory        | Preserves directory inode                 |
| Upstream type                  | Trusted caller/stored value                | Derived from actual upstream              |
| Firewall implementation        | Multiple drifting shell copies             | One shared implementation                 |
| nftables                       | Missing/inaccurate                         | Explicitly detected and managed           |
| Port verification              | Some paths assumed command success         | Re-inspection after opening               |
| Ansible ports                  | Implicit inside profiles                   | Profiles declare service requirements     |
| Jenkins `HOST_PORT`            | Run-time editable and could become stale   | CloudForge-owned and reasserted           |
| Cloudflare DNS                 | Could repoint a foreign record             | Foreign records protected                 |
| Runtime UI                     | Did not exist                              | VPS Runtime inspect/preview/apply page    |
| Runtime storage                | Did not exist                              | JSON in existing `Setting` table          |
| Database migration             | Not applicable                             | None required                             |

---

## Automated test status

### Claimed branch result

The branch documentation records 714 passing tests in the environment used
during development.

### Result reproduced on this Windows workspace

The repository test command was run without changing source files.

Passed before pnpm stopped:

| Package           | Result                |
| ----------------- | --------------------- |
| Shared            | 18 passed             |
| UI                | 2 passed              |
| Core              | 422 passed            |
| Database          | 12 passed             |
| Providers         | 13 passed             |
| Service providers | 10 passed             |
| Deployment        | 185 passed, 20 failed |

### Explanation of the 20 failures

The new deployment tests execute:

```text
sh -n
```

The current Windows environment does not have a usable `sh` executable in
`PATH`. Even a control script containing only `echo hello` failed for the same
reason.

Therefore these failures do not prove that the generated firewall/Nginx shell
is invalid. They prove that the tests currently require a POSIX shell and are
not portable to this Windows setup without:

- Providing a real `sh`.
- Running the affected package in Linux/WSL with a configured distribution.
- Or making the tests platform-aware.

Because pnpm stopped after the deployment package, the complete claimed
714-test run was not reproduced locally on Windows.

### Other static result

```bash
git diff --check main...HEAD
```

passes, so the branch diff has no whitespace errors detected by Git.

---

## Required live migration verification

Automated tests cannot prove that an existing production VPS remains untouched.
These checks must be performed before merging.

### 1. Capture the current containers

Before running the refactored application:

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | sort > /tmp/before.txt
```

### 2. Exercise read-only application pages

In CloudForge:

1. Open **Containers** and refresh.
2. Open **Ansible** and refresh profile states.
3. Open **Nginx** and load sites.
4. Open **SSL & Domains** and load certificates.
5. Open **VPS Runtime**, select the target, and choose **Inspect VPS**.

For an existing target, VPS Runtime should report `legacy` and should not apply
topology changes.

### 3. Compare containers

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

Expected result:

```text
no output
```

An empty diff means inspection did not recreate, restart, remove, or republish
containers.

### 4. Verify Nginx unification

Open one existing CloudForge-managed domain in Nginx Manager and press Save.
Then run:

```bash
ls -la /etc/nginx/conf.d/
grep -R "server_name" /etc/nginx/conf.d/
sudo nginx -t
```

Expected:

- One canonical CloudForge file for that domain.
- No stale second file with the same `server_name`.
- `nginx -t` succeeds.
- The application still serves traffic.
- WebSocket routes still exist where configured.

### 5. Verify firewall truth

Compare:

- Ansible's displayed firewall state.
- VPS Runtime connectivity.
- The dedicated Firewall page.
- Actual host rules.

Useful commands depend on the detected backend:

```bash
sudo ufw status
sudo firewall-cmd --list-all
sudo nft list ruleset
sudo iptables -S
```

Only run the command appropriate for the host.

### 6. Verify Cloudflare protection

Test three non-production records:

1. A CloudForge-marked record: update should be allowed.
2. An unmarked record already pointing to the VPS: save should leave it
   unmodified.
3. An unmarked record pointing elsewhere: save should fail without changing
   DNS.

### 7. Verify Jenkins port ownership

For a CloudForge-managed domain:

1. Synchronize Jenkins parameters.
2. Confirm `HOST_PORT` equals the application port.
3. Confirm the Run form cannot override it.
4. Run the pipeline.
5. Confirm Nginx still proxies to the same port.

---

## Main implementation file map

The exact changed-file list is available through Git, but these are the main
areas another engineer or AI should inspect.

### Runtime domain and application services

```text
packages/core/src/domain/runtime/
packages/core/src/application/runtime/
packages/core/src/ports/runtime-plan-store.ts
packages/core/src/ports/runtime-inspector.ts
packages/core/src/ports/runtime-applier.ts
```

Important responsibilities:

- Plan model and validation.
- Ownership.
- Drift.
- Required ports.
- Operation derivation.
- Preview/apply.
- Adoption.
- Runtime persistence abstraction.

### Deployment adapters

```text
packages/deployment/src/ssh-runtime-inspector.ts
packages/deployment/src/ssh-runtime-applier.ts
packages/deployment/src/docker-inspect.ts
packages/deployment/src/host-firewall-script.ts
packages/deployment/src/nginx-site-file.ts
packages/deployment/src/nginx-exec-script.ts
```

Important responsibilities:

- SSH-based live inspection.
- Docker topology reads.
- Safe network operations.
- Host firewall commands.
- Unified Nginx naming/rendering.
- Native/container command execution and rollback.

### Database adapter

```text
packages/database/src/prisma-runtime-plan-store.ts
```

### Desktop main process and typed IPC

```text
apps/desktop/src/main/ipc/handlers/runtime.handlers.ts
apps/desktop/src/main/container.ts
packages/shared/src/ipc/
```

### Desktop renderer

```text
apps/desktop/src/renderer/src/features/vps-runtime/
```

### Other major modified features

```text
packages/core/src/application/jenkins/
packages/core/src/application/cloudflare/
packages/core/src/application/nginx/
packages/core/src/application/container/
packages/deployment/src/ansible-playbooks.ts
```

---

## Relationship with the Automation Studio documents

The files under:

```text
docs/automation-studio/
```

are primarily a reverse-engineered Phase 0 baseline. They describe the system
before the runtime refactor and are useful for understanding why the refactor
was needed.

They are not the authoritative current inventory because they still describe
older facts such as:

- No VPS Runtime page.
- Direct lower-level container/Ansible manager use.
- The pre-runtime IPC inventory.
- No persisted `VpsRuntimePlan`.

For current runtime behavior, use:

- `docs/VPS-RUNTIME.md`
- `docs/RUNTIME-MIGRATION.md`
- `docs/RUNTIME-REFACTOR-PHASES.md`
- This document.

---

## Final assessment

The branch is primarily a safety and architecture refactor, not a replacement
for the existing deployment system.

Its most important completed changes are:

1. A shared VPS topology model.
2. Ownership-aware drift.
3. Explicit adoption.
4. Preview tokens bound to live state.
5. Limited, guarded topology Apply.
6. Secure target-based container IPC.
7. Unified firewall logic with nftables.
8. Proxy reachability validation.
9. Safe containerized Nginx editing and rollback.
10. Stable CloudForge-owned Jenkins ports.
11. Protection against overwriting foreign Cloudflare DNS.
12. A new read-mostly VPS Runtime page.

Its most important incomplete area is automatic synchronization:

> Jenkins, Nginx, SSL, Cloudflare, Firewall, and runtime planning do not yet all
> read from and write to one persisted topology automatically.

The branch provides the domain and adapters required to move toward that goal,
while existing targets remain in the non-mutating `legacy` mode by default.

---

## Suggested prompt for another AI

Copy this document to another AI and use:

```text
Read this entire CloudForge runtime-refactor change record.

Explain it to me as a practical story using one example VPS that contains:
- native Nginx,
- Jenkins,
- Docker applications,
- Cloudflare DNS,
- host and OCI firewalls.

For every change, explain:
1. what CloudForge did before,
2. the concrete failure that could happen,
3. what the branch changed,
4. what I will see in the UI now,
5. what CloudForge will and will not modify,
6. what I must test before merging.

Clearly separate completed functionality from architectural foundations that
are not yet automatically synchronized.
```
