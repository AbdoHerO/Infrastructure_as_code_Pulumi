# Runtime topology synchronization

## Why this migration exists

`VpsRuntimePlan` was introduced as the provider-independent description of what
runs on a VPS. The first runtime-refactor made Docker networks, containers,
volumes, routes, ownership, drift, preview/apply, and host-firewall
requirements understandable in one place. It did not yet make every existing
feature write its successful changes back to that model.

Before this migration, the same topology was still split across several
authorities:

| Feature           | Previous authority                                                  | Why Runtime was stale                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jenkins Pipelines | `JenkinsPipelineRepository` plus the remote Jenkins job             | Saving a pipeline persisted `HOST_PORT`, domain, definition mode, and target, but never created a runtime application or endpoint.                                         |
| Nginx             | Live files on the VPS                                               | Managed sites could be created, edited, removed, or discovered without updating `VpsRuntimePlan.routes`. A route therefore could not reliably name its application.        |
| SSL               | Live certificate files plus `Settings.ssl.managed` renewal metadata | Certificate status, expiry, HTTPS, and redirect state were not runtime resources and could not participate in drift.                                                       |
| Cloudflare        | Cloudflare's API                                                    | CloudForge-owned DNS records had an ownership marker, but Runtime did not know which hostname pointed to which target.                                                     |
| Firewall          | Live host firewall and the provider Firewall page                   | Runtime already read the host firewall, but provider rules were supplied manually by the caller. The Runtime page therefore usually reported the provider side as unknown. |

The external systems remain the authority for their _observed_ state: Docker,
Nginx, Jenkins, certificate files, Cloudflare, the VPS firewall, and the cloud
provider are still read through their existing ports. `VpsRuntimePlan` becomes
the authority for CloudForge's desired and owned cross-feature topology.

## Design

The migration extends the existing architecture rather than adding another
repository:

1. `RuntimeTopologySynchronizer` is an Application-layer port.
2. `RuntimePlanService` implements it using the existing `RuntimePlanStore`,
   validator, optimistic plan version, and Activity service.
3. Feature services receive the port as an optional constructor dependency.
   Existing tests and third-party compositions remain source-compatible.
4. A feature synchronizes Runtime only after its external operation and its own
   persistence succeed.
5. Existing resources are migrated lazily when their normal list/read workflow
   observes them. No upgrade-time command touches a VPS.
6. Missing fields on schema-version-1 JSON are normalized on read. No database
   migration and no destructive rewrite are required.

Targets remain in their existing runtime mode. In particular, a `legacy`
target may acquire an accurate topology record, but Runtime apply still refuses
to mutate it. Recording knowledge is not the same as taking ownership.

## Resource mapping

### Jenkins

A saved pipeline owns one `RuntimeApplication` and one host endpoint
`RuntimeService`. The endpoint records the effective `HOST_PORT`, loopback
exposure, SCM/inline deployment mode, repository source, and CloudForge
ownership. Updating a pipeline updates those records in place. Routes already
pointing to the same domain and port are relinked to this application. Deleting
the pipeline removes its ownership; an Nginx route that still exists retains a
route-owned endpoint instead of becoming invalid.

### Nginx

Every managed site owns a runtime route for `/` and one for each configured
location. The route records its owning application, upstream, port, WebSocket,
TLS, and redirect intent. Listing sites reconciles all CloudForge-managed Nginx
routes, which migrates sites created by older versions without changing their
files. External sites remain visible in Nginx but are never claimed by Runtime.

### SSL

Successful issue and renewal operations upsert a runtime certificate. Listing
certificates reconciles the observed status and expiry. The certificate is
linked to the managed Nginx site's HTTPS and redirect state. Drift compares the
desired certificate resource with the most recently observed certificate
status; an expired or missing certificate is reported without issuing,
renewing, or deleting anything.

### Cloudflare

Only records carrying the existing `Managed by CloudForge` marker become
CloudForge-owned runtime DNS resources. Automatic DNS, manual CRUD, and normal
record listing synchronize those records. Foreign records are not claimed,
modified, or reported as unexpected Runtime resources. A target link is made
only when the origin address matches a saved VPS.

### Firewalls

Host firewall state remains a live SSH observation. Provider firewall state is
resolved at connectivity-check time from the target's managed project,
provider credential, and compute resource. Runtime does not persist a second
copy of either firewall. The existing optional provider argument remains for
backward compatibility, but normal Runtime connectivity no longer requires a
manual caller-side synchronization.

## Failure and compatibility rules

- Runtime synchronization uses `Result<T, E>` and never bypasses IPC or an
  existing Application service.
- A failed external operation never updates Runtime.
- A failed Runtime synchronization is returned to the caller and recorded; it
  is not silently described as synchronized.
- Plan writes use optimistic versions and retry only a fresh, re-derived
  mutation. They never overwrite an unrelated concurrent edit.
- Optional constructor dependencies keep existing compositions working while
  the desktop composition enables the complete integration.
- Schema-version-1 plans load with empty certificate and DNS collections and
  with legacy container defaults.
- Foreign Cloudflare records, external Nginx sites, and unmanaged Docker
  resources remain outside CloudForge ownership.

## Verification

The automated suite covers:

1. Jenkins create, update, and delete synchronization.
2. Nginx save, list reconciliation, route update, and delete.
3. SSL issue/list/renew state and certificate drift.
4. Cloudflare managed-record create/update/list/delete and ownership guards.
5. Live host plus provider firewall connectivity without renderer-supplied
   state.
6. Loading old runtime-plan JSON and preserving legacy mode.
7. Existing Oracle, AWS, Ansible, Jenkins, Nginx, SSL, and Cloudflare tests.

For a live VPS, validate in this order:

1. Open **VPS Runtime**, inspect a legacy target, and confirm no apply occurs.
2. Open **Nginx**, refresh sites, then return to Runtime and confirm routes and
   their applications appear.
3. Open **Jenkins Pipelines**, save one pipeline, and confirm its port and
   deployment mode in Runtime.
4. Load SSL certificates and confirm expiry/status; do not issue a certificate
   solely for migration testing.
5. Refresh Cloudflare DNS and confirm only `Managed by CloudForge` records are
   owned by Runtime.
6. Run Runtime connectivity and confirm both host and provider firewall
   verdicts are current.
