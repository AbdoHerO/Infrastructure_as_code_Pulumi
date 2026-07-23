# The runtime refactor, phase by phase

A complete record of what changed on the `runtime-refactor` branch, why, and how
to verify each piece.

**Totals:** 9 commits, 91 files, +14,545 / −1,053. Test suite went from 198 tests
(2 failing) to 714, all green. `typecheck`, `lint`, `test` and `build` are clean
at every commit.

---

## Why this branch exists

The VPS runtime layer grew feature by feature over time, and **no single place
knew what a VPS's topology actually was**. Each module had built its own partial
answer:

| Module     | Knew about                            | Could not see           |
| ---------- | ------------------------------------- | ----------------------- |
| Ansible    | Native service ports (`service_port`) | Containers, routes      |
| Jenkins    | `HOST_PORT`, the application domain   | Nginx, firewalls        |
| Nginx      | Upstream host and port                | Which container that is |
| Firewall   | The cloud provider's security list    | The VPS's own firewall  |
| Containers | What is running right now             | What is _meant_ to be   |
| Cloudflare | DNS records                           | Who created them        |

Because no module could see the others, the application could not answer two
questions that matter:

1. **Can this port actually carry traffic?** It needs both the host firewall and
   the cloud security list to allow it, and those lived on different screens with
   nothing relating them.
2. **Is CloudForge allowed to touch this container?** Nothing recorded ownership,
   so the honest answer was "nobody knows" — and the code assumed "yes".

This branch introduces one authoritative model, `VpsRuntimePlan`, and connects
every module to it.

### The governing rule

> **A resource CloudForge does not own is never drift.**

Everything in this branch follows from that sentence. A VPS carries containers,
networks, volumes, firewall rules and DNS records put there by people and other
tools for reasons this application cannot see. The runtime layer reports on them
and refuses to change them.

### The safety posture

Every target is `legacy` until a human says otherwise. Legacy means _read, never
write_, and it is the state of every existing target after upgrade because
`legacy` is what "no stored plan" resolves to. Nothing in the upgrade path writes
a plan for you.

---

## Phase 0 — Fix what was already broken

**Commit:** part of `f72bc8c`

Before building a model on top of the runtime layer, four existing defects had to
go, because a model built over them would have encoded the bugs.

### 0.1 — Nginx had two writers that could not see each other

The Ansible "domain" tab and the Nginx Manager both wrote site files, using
**different file names and different metadata formats**.

Consequences:

- A site created by the Ansible tab was **invisible** to Nginx Manager.
- SSL **refused to issue** for it, because it could not find the site.
- Saving the same domain through both tabs left **two files with one
  `server_name`** — which Nginx resolves by silently ignoring one of them. Which
  one depends on read order.

**Fix.** Both writers now share one renderer, one file convention, and clean up
the stale legacy file inside the same transaction that writes the new one.

New file: `packages/deployment/src/nginx-site-file.ts`

| Function                      | Purpose                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `managedSiteFilePath()`       | The one canonical path: `/etc/nginx/conf.d/cloudforge-<domain>.conf`                                           |
| `legacyAnsibleSiteFilePath()` | The pre-unification name, so it can be found and removed                                                       |
| `siteFilePaths()`             | Both, de-duplicated when they coincide                                                                         |
| `toManagedNginxSite()`        | Widen the 4-field tab model into the rich model, **preserving** TLS, routes and headers the richer editor owns |
| `toNginxSite()`               | Narrow back to the 4 fields that tab presents                                                                  |

Reading still accepts **both** formats, so sites written by older releases keep
working.

### 0.2 — Enabling SSL silently deleted your routes

`renderManagedNginxSite` built the HTTPS server block without the additional
locations, headers, proxy timeouts, compression or custom snippets that the HTTP
block had. Additional routes also never received forwarding or WebSocket upgrade
headers.

So the moment you turned TLS on, every extra route stopped working — and a
WebSocket route was broken even over plain HTTP.

**Fix.** One proxy body, rendered identically into both blocks. A test asserts the
two blocks contain the same set of `location` directives.

### 0.3 — Container IPC let the renderer pick its own host key

The container channels accepted a `host` **and a host-key fingerprint** from the
renderer. That means the caller chose which fingerprint to verify against — which
is not verification. A compromised or buggy renderer could point the main process
at any host and tell it to trust anything.

**Fix.** The channels take a `targetId`. The main process loads the saved target
and its pinned key itself. The renderer no longer names a host at all.

### 0.4 — The certificate manager had its own firewall shell

`ssh-certificate-manager.ts` carried a private `httpsFirewallScript()` — one of
five copies of the same logic in the codebase.

**Fix.** Deleted, replaced with `openPortsFragment([80, 443])` from the shared
builder. A new test asserts the firewall opens **before** certbot runs, which is
the guarantee that actually matters.

**How to test Phase 0**

Open one existing domain in **Nginx Manager**, press **Save**, then on the VPS:

```sh
ls /etc/nginx/conf.d/
```

Expect **exactly one** `cloudforge-*.conf` for that domain. Then enable SSL on a
site that has extra routes and confirm the routes still answer.

---

## Phase 1 — The model

**Commit:** part of `f72bc8c`
**Files:** `packages/core/src/application/vps-runtime/vps-runtime-plan.ts` (+ tests)

`VpsRuntimePlan` is the declarative description of what a VPS's topology should
be. It is generic: no product names, no fixed container names, no assumed ports
or domains.

### Shape

```
VpsRuntimePlan
├── targetId, version, schemaVersion, updatedAt
├── mode           legacy | hybrid | managed
├── reverseProxy   none | external | native-nginx | container-nginx | container-traefik | container-caddy
├── networks[]     name, driver, internal, scope, labels
├── applications[] name, displayName, composeProject, sourceMode
├── services[]     name, applicationName, kind, containerName, image,
│                  exposure, ports[], networks[], serviceReferences[],
│                  volumes[], restartPolicy
├── routes[]       domain, serviceName, servicePort, tls
└── adoptions[]    dockerName, resourceKind, adoptedAt, note
```

### Exposure — the distinction that was missing

| Exposure        | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `proxy-only`    | No host port at all. Reachable only from a Docker network.     |
| `host-loopback` | Published to `127.0.0.1` only. No firewall rule can expose it. |
| `direct`        | Published to the world. Needs a firewall rule.                 |

Conflating loopback with public is how a VPS ends up with ports open for nothing,
or a user hunting a firewall rule that could never have helped.

### The validator rejects topologies broken by construction

It refuses things that **cannot work**, rather than warning about things that
merely look odd:

| Issue id                | Rejects                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.reference.*`   | Service A referring to service B when they share no network — the name would never resolve                                                                           |
| `route.unreachable`     | A route whose proxy could never reach the service (see Phase 5a)                                                                                                     |
| `network.labels.secret` | A Docker label whose key looks like a credential (`password`, `token`, `secret`, `api_key`, …). Labels are world-readable to anything that can run `docker inspect`. |
| `adoption.duplicate`    | The same resource adopted twice                                                                                                                                      |
| `port.*`, `name.*`      | Values that would be unsafe or meaningless in a shell command                                                                                                        |

**Design note.** `emptyRuntimePlan(targetId)` returns a `legacy` plan at version 0. Absence of a plan is answered with this rather than an error — the honest
description of "no recorded intent" is a plan that changes nothing.

---

## Phase 2 — Ownership, observation, drift

**Commit:** part of `f72bc8c`

### 2a — Ownership vocabulary

**File:** `packages/core/src/application/vps-runtime/runtime-ownership.ts`

| Ownership            | Meaning                                               |
| -------------------- | ----------------------------------------------------- |
| `cloudforge-managed` | CloudForge created it, and its labels prove it        |
| `adopted`            | CloudForge did not create it, but the plan claims it  |
| `legacy-managed`     | Carries an older CloudForge marker                    |
| `unmanaged`          | **The default.** Nobody knows, so nobody may touch it |

Ownership is read from Docker labels. `unmanaged` is what an unrecognised
resource gets — never a guess.

### 2b — Read-only observation

**Files:** `packages/core/src/application/ports/runtime-inspector.ts`,
`packages/deployment/src/ssh-runtime-inspector.ts`,
`packages/deployment/src/docker-inspect.ts`

Reads containers, networks and volumes over verified SSH.

**Why `docker inspect` and not `docker ps`.** `docker ps` renders `8080/tcp`
(exposed — reachable from nowhere) and `0.0.0.0:80->80/tcp` (published —
reachable from the internet) in the same column. A tool that cannot tell those
apart cannot report whether a port is exposed to the world, which is the entire
question. `docker inspect` gives them separately.

### 2c — Drift detection

**File:** `packages/core/src/application/vps-runtime/runtime-drift.ts`

Compares the plan against the observation. **Pure** — no I/O, so it is fully
testable.

```
DriftKind:      missing | unexpected | modified | ownership-conflict | adoptable
DriftSeverity:  info | warning | error
```

Roughly two dozen drift ids: `network.missing`, `container.alias.missing`,
`container.port.unexpected`, `volume.ownership-conflict`, `docker.unavailable`, …

**Three rules that make it trustworthy:**

1. **Legacy mode is always `inSync`.** There is nothing to drift from when
   nothing is claimed.
2. **Unowned resources are never drift.** Enforced by `isOwnedByTarget()`, which
   requires both effective ownership _and_ the target's own label.
3. **Docker unavailable produces one entry**, `docker.unavailable` — not a page
   of derived failures that all say the same thing.

`blockingDrift()` returns only `ownership-conflict` and `adoptable` — the two
kinds that must stop an apply, because both mean CloudForge is about to act on
something that is not its.

### 2d — The plan service

**File:** `packages/core/src/application/vps-runtime/runtime-plan-service.ts`

The one entry point. Methods: `get`, `validate`, `save`, `setMode`, `adopt`,
`release`, `connectivity`, `openRequiredPorts`, `inspect`, `drift`, `preview`,
`apply`, `delete`.

**Guarantees:**

- `save` takes `targetId` from the **argument**, never the payload, so a caller
  cannot write another target's plan.
- Version conflicts are rejected — two windows cannot silently overwrite.
- Plans are size-bounded (512 KB), so a corrupt payload cannot fill the database.
- `adopt` requires the resource to **exist**. You cannot adopt a fiction.
- `openRequiredPorts` refuses in legacy mode.

**Adoption is a plan edit, not a VPS operation.** This is forced, not chosen:
Docker labels are **immutable after creation**. There is no `docker network
update` at all, and `docker container update` does not touch labels. The only way
to relabel a network is to destroy and recreate it, disconnecting every container
on it. So adoption writes one line to the plan and touches the VPS not at all.

> I originally implemented adoption as an operation that stamps labels onto an
> existing resource, then discovered it was impossible, and rewrote it. The
> preview would have promised something Docker cannot do.

### 2e — Persistence

**Files:** `packages/core/src/application/ports/runtime-plan-store.ts`,
`packages/database/src/repositories/prisma-runtime-plan-store.ts`

Versioned JSON in the existing `Setting` table. **No schema migration**, no new
column, no new table.

> **Deliberate departure from the approved plan.** The plan called for
> denormalised `runtimeMode` and `reverseProxyMode` columns on `VpsTarget`. I
> dropped them. The plan JSON already owns those facts, and a column can silently
> disagree with it — the exact "duplicate competing sources of truth" this
> refactor exists to remove.

---

## Phase 3 — Operations and the applier

**Commit:** part of `f72bc8c`
**Files:** `runtime-operations.ts`, `ports/runtime-applier.ts`,
`deployment/ssh-runtime-applier.ts`

### What CloudForge will and will not do

> **It does not create, restart or remove containers.** Containers belong to
> Compose and to Jenkins. What the runtime layer owns is the topology _around_
> them — networks, attachments and aliases.

Where a change genuinely requires a container to be recreated, the operation kind
is `manual`: reported, explained, **not performed**.

### Operation kinds and risks

```
kinds:  create | attach | detach | remove | manual
risks:  safe | disruptive | destructive
```

| Operation                     | Risk        |
| ----------------------------- | ----------- |
| `network.create:<name>`       | safe        |
| `container.attach:<c>:<n>`    | safe        |
| `container.alias:<c>:<n>`     | disruptive  |
| `container.detach:<c>:<n>`    | disruptive  |
| `network.remove:<name>`       | destructive |
| `network.recreate:<name>`     | manual      |
| `manual.redeploy:<container>` | manual      |

### The preview token

1. `preview` reads live state, derives the operations, and mints a token bound to
   a **fingerprint** of that exact change.
2. `apply` sends the token back. The main process **re-derives the change from
   live state** and refuses a token whose fingerprint no longer matches.
3. Blockers refuse outright. Destructive operations additionally require the
   resource's exact name, typed.
4. The token is **spent either way**.

So a VPS that moved between preview and apply cannot be acted on with stale
intent.

### Two deliberate shell decisions

- **`network.remove` carries no `--force`.** Docker's own refusal to delete a
  network in use is a safety net worth keeping.
- **`container.alias` emits `disconnect … || true; connect …`** because Docker
  fixes aliases at connect time; there is no other way to change one.
- **`SAFE_NAME`** (`/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/`) gates every value that
  reaches a shell command.

A failed operation **stops the run**; the remainder are recorded as `skipped`
rather than attempted against a state that is no longer understood.

---

## Phase 4 — Firewalls

**Commits:** part of `f72bc8c`, plus `3345554`

### 4a — The host firewall port

**Files:** `ports/host-firewall.ts`, `deployment/ssh-host-firewall-manager.ts`

```
backends: ufw | firewalld | nftables | iptables | none | unknown
```

`HostFirewallState.indeterminate` is a first-class field. **A firewall that could
not be read is not the same as a host with no firewall.** Reporting the second
when the first is true tells a user their port is reachable when it is not.

`change()` runs the change and then **re-inspects**. The verification is the
point: a firewall command can exit zero and still leave the port unreachable — a
`ufw` rule shadowed by an earlier `deny`, an iptables rule inserted below a
`REJECT`.

### 4b — One shell builder

**File:** `packages/deployment/src/host-firewall-script.ts`

Replaced **five drifted copies** of the firewall shell (Jenkins playbook, Ansible
probe, certificate manager, preflight check, bootstrap template). Between them:

- Only one knew **nftables** existed.
- Only one could **read a rule back**.
- **None** could close a port.
- The marker comment **differed between the writer and the reader**, so CloudForge
  could add a rule and then fail to recognise it as its own.

**nftables is detected before iptables** because on a modern distro `iptables` is
usually a compatibility shim over nftables. Driving the shim while reading the
real table is how rules appear to vanish.

`ufw` and `firewalld` are checked for _activity_, not presence — Debian ships
`ufw` installed and inactive, and treating that as "the firewall" reports a port
as blocked when nothing is blocking it.

The scripts are pure string builders, so a real `sh -n` can parse them in tests.
That is the only way this shell ever gets tested at all.

### 4c — Requirements and connectivity

**File:** `packages/core/src/application/vps-runtime/firewall-requirements.ts`

A **requirement** states that a port must be open for something to work. Whether
CloudForge opens it is a separate question — which is why a port you firewalled
by hand still shows up, correctly, as blocked.

- **Port 80 is required even when every route is HTTPS**, because ACME's HTTP-01
  challenge needs it.
- **SSH is never included.** CloudForge is talking to the VPS over SSH; if that
  port were shut, nothing here would be running.
- **`host-loopback` never generates a requirement.** No firewall rule can make
  loopback reachable.

```
ConnectivityState: reachable | blocked-host | blocked-provider | blocked-both | unknown
```

A port is `reachable` only when **both** firewalls allow it. When the provider's
rules were not supplied, every verdict is `unknown` and `providerUnknown` says so
in one place, rather than leaving the UI to infer it from a page of shrugs.

### 4d — Reading the cloud security list (`3345554`)

`toProviderFirewallView()` converts provider rules into a firewall view, and is
strict about what counts as "open to the world":

- `direction === 'ingress'` only.
- CIDR must be `0.0.0.0/0` or `::/0`.
- A null port range means all ports; `all` protocol matches both tcp and udp.
- **A half-stated range is read narrowly.**

> A test asserted that `portFrom: 8000, portTo: null` should reach 65535. The code
> read it narrowly and the test failed. **The code was right.** Reading generously
> claims more ports are open than the rule proves, and a port wrongly called open
> sends someone hunting a bug that is a firewall rule. I fixed the test.

---

## Phase 5a — Route reachability and derived upstreams

**Commits:** part of `f72bc8c`, plus `e1852b1`

### Routes are validated against the proxy that has to serve them

A reverse proxy can only reach a service it can address. The validator now knows
the difference:

| Proxy mode         | Requirement                                                            | Otherwise              |
| ------------------ | ---------------------------------------------------------------------- | ---------------------- |
| `native-nginx`     | The service must publish a **host port** (`direct` or `host-loopback`) | `route.unreachable`    |
| `container-nginx`  | The service must share a **`shared-proxy` network**                    | `route.unreachable`    |
| (no proxy network) | —                                                                      | `route.noProxyNetwork` |

**Why.** Nginx running on the host cannot resolve a Docker container name. A route
pointing at a `proxy-only` service from a host-based Nginx returns **502**, every
time, forever. That is not a warning — it is a topology that cannot work.

> This rule broke four of my own test fixtures. They described shared-proxy
> topologies while inheriting the `native-nginx` default — i.e. they described
> arrangements that would 502. The rule was right; the fixtures were wrong.

### `upstreamKind` is derived, not believed (`e1852b1`)

`ManagedNginxSite.upstreamKind` answers "could a proxy that is not on a Docker
network resolve this?". The only evidence is the host. It was being **taken from
the caller**, so a stored value could contradict the host it described — and
everything downstream trusted it.

Now derived on validation:

```
127.0.0.1, localhost, 10.0.0.5, [::1], db.example.com  →  host
api, shop-redis                                        →  docker
```

A bare single-label name is only meaningful inside a Docker network.

---

## Phase 5b — The containerised proxy

**Commit:** `8dfc3ac`
**Files:** `packages/deployment/src/nginx-exec-script.ts` (new),
`ssh-nginx-manager.ts`

### The gap

The status probe could always _see_ a containerised Nginx. Everything that
_changed_ a config refused it outright:

```sh
command -v nginx >/dev/null 2>&1 || { echo 'Docker Nginx editing requires …'; exit 1; }
```

So a VPS whose proxy runs in Docker could be inspected and **never edited**.

### The bug underneath it

Making it work was the easy half. The transaction's rollback did:

```sh
rm -rf /etc/nginx
tar -xzf backup.tar.gz -C /
```

Fine for a native install. **Wrong the moment `/etc/nginx` is bind-mounted into a
container**: removing the directory strands the container's mount on a _deleted
inode_. The restore then lands in a new directory the container cannot see, and it
carries on serving the config that was just rolled back — until someone restarts
it and finds out.

**A failed validation would have left Nginx worse than the change it rejected.**

### The fix

```sh
find /etc/nginx -mindepth 1 -delete   # keeps the directory, and its inode
tar -xzf backup.tar.gz -C /
```

Emptying **first** rather than extracting over the top, because extraction alone
leaves behind anything added since the archive was taken — including the file
whose failed validation caused the rollback. This is strictly better for native
installs too, so both paths use it.

### The mount is proved, not assumed

Editing a container still requires it to share the host's `/etc/nginx`. Before any
change, CloudForge writes a dotfile on the host and checks the container can see
it:

```sh
: > '/etc/nginx/.cloudforge-mount-probe'
docker exec "$cf_proxy" test -f '/etc/nginx/.cloudforge-mount-probe' || refuse
```

A container with its own baked-in `/etc/nginx` would otherwise validate a config
with nothing to do with the one just written and **report success** — which looks
exactly like it worked. The probe also catches a wrongly-identified container for
free. It is a dotfile, so `conf.d/*.conf` can never pick it up.

### Two more call sites had the same problems

- `restore()` had the identical `rm -rf`.
- `reload()` had **no proxy awareness at all** — `systemctl reload nginx` on a
  host whose Nginx is a container reloads nothing.

All three now share one preamble defining `cf_nginx` and `cf_nginx_reload`.

**A native binary still wins when both exist**, matching what the status probe
reports, so every existing native install behaves exactly as before.

---

## Phase 6 — One firewall, and profiles that declare themselves

**Commit:** `8f53964`

### 6a — The last two shell copies

Two copies of the firewall shell survived Phase 4: the Ansible playbook's task
and the profile probe's `firewall_state()`. **Neither knew nftables existed.**

| Copy         | Failure on an nftables host                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Playbook** | Drove the iptables compatibility shim — or, with no iptables binary at all, **opened nothing and reported success** |
| **Probe**    | Read the shim, missed CloudForge's own `inet cloudforge` table, and **reported an open port as closed**             |

A wrong answer is worse than no answer: it sends someone hunting a bug that is a
firewall rule.

**Two obstacles, and how each was solved:**

1. **The playbook's port is a Jinja expression** (`{{ service_port }}`) that does
   not exist when the string is built, so `openPortsScript(ports)` — which asserts
   real integers — cannot be used. The builder now exposes `openPortsPreamble()`
   and `persistIfChanged()`, and the playbook makes its own call. The value is
   validated as an integer in 1–65535 before it is ever rendered into `vars.json`,
   so nothing unchecked reaches the shell.

2. **The probe runs unprivileged and escalates per command**, unlike everything
   else, which runs inside a script `runPrivilegedScript` already executes as root.
   Rather than thread `sudo` through by hand, the builders take an optional prefix
   and the probe passes its own `'$S '`. It also widens `PATH` with
   `/usr/sbin:/sbin` — without that, an unprivileged `command -v nft` fails and the
   whole detection falls through to "no firewall".

**Testing the generated shell inside YAML.** The playbook's script lives in a YAML
block scalar. An indentation mistake there does not break the YAML — it **silently
truncates the script**. The tests therefore pull the script back out _through the
YAML parser_ and hand it to `sh -n`. Verified by breaking the indent and watching
7 tests fail.

### 6b — Profiles declare their runtime

**Files:** `ports/ansible-manager.ts`, `vps-runtime/ansible-runtime-requirements.ts`,
`ports/native-service-requirements.ts`, `deployment/ansible-native-service-requirements.ts`

Nothing outside the Ansible page could reason about a Jenkins on 8080, so the
connectivity check would report a target as fully reachable **while its Jenkins was
firewalled off**.

Each profile now declares what it needs:

| Profile   | Declares                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker    | **No ports.** It listens on a Unix socket and is reached over SSH. Declaring a port here would invite exactly the unauthenticated Docker socket that must not exist. |
| Dockhand  | `service_port` (default 3000)                                                                                                                                        |
| Portainer | `service_port` (default 9443)                                                                                                                                        |
| Jenkins   | `service_port` (default 8080)                                                                                                                                        |
| Nginx     | 80 — **and deliberately not 443**                                                                                                                                    |

> **Why Nginx does not declare 443.** 443 is needed only when a route actually
> terminates TLS, which the runtime plan already derives from its own routes.
> Declaring it in both places would create the second competing source of truth
> this refactor exists to remove — and would ask the user to open 443 on a VPS
> that serves nothing over it.

`connectivity()` and `openRequiredPorts()` now read **one merged list**, so the
screen cannot list a port as required and then decline to open it.

The declaration is **optional**: a profile that has not declared a runtime
contributes nothing and nothing about it is assumed.

**Isolation preserved.** The runtime layer has no business knowing Ansible exists.
`NativeServiceRequirements` is a one-method port; `AnsibleNativeServiceRequirements`
in the deployment package implements it. Neither side imports the other.

---

## Phase 7 — `HOST_PORT` is owned, not suggested

**Commit:** `898fd84`
**Files:** `ports/jenkins-manager.ts`, `jenkins/jenkins-pipeline-service.ts`,
`renderer/features/jenkins/JenkinsPage.tsx`

`HOST_PORT` is the port the generated Nginx site proxies to. Anything that moves
one without the other deploys the container **where the proxy is not looking**, and
the domain answers **502 with nothing in the pipeline log to explain it**.

It was broken four ways:

| #   | Bug                                                                                                                                           | Fix                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `trigger()` merged the caller's parameters over the defaults and stopped — and the run form showed `HOST_PORT` as an **editable text box**    | Managed values assigned **last**, so a caller cannot win                         |
| 2   | `status()` re-asserted `CLOUDFORGE_ENV_CREDENTIAL_ID` but **not** `HOST_PORT`, so a Jenkins-side edit was read back as the plan, indefinitely | Restated on **every read**. Jenkins is not the record of intent; the pipeline is |
| 3   | Switching domain automation off **left the parameter behind**, default frozen at the old port                                                 | Withdrawn — **but only when the stored record says CloudForge added it**         |
| 4   | Nothing marked the parameter as owned, so the renderer hardcoded one name and `HOST_PORT` fell through as editable                            | `JenkinsParameter.managed`, derived on read, never believed from outside         |

**Corrected, not rejected.** The run form legitimately sends back the value it was
shown; turning that into an error would break the button. What must never happen is
the _other_ case — a caller sending a different value and having it honoured.

**Requirement 20 respected.** A `HOST_PORT` you wrote by hand on a pipeline that
never had domain automation enabled is **not CloudForge's to remove**. The stored
record's own `configureDomain` is the evidence.

Also stopped keeping the caller's `description` on a parameter this service owns,
which let it describe itself as something else.

> **Verified negative:** neutering the trigger override made `HOST_PORT: '9999'`
> reach Jenkins in a failing test. That is the 502, reproduced.

---

## Phase 8 — The VPS Runtime page

**Commit:** `19fc483`
**Files:** `renderer/features/vps-runtime/VpsRuntimePage.tsx`, `useRuntime.ts`,
`app/router.tsx`, `app/navigation.ts`, `main/security/runtime-renderer-policy.test.ts`

Everything in phases 0–7 was reachable only from tests. This is the screen that
exposes it: **Manage → VPS Runtime**.

| Card             | Does                                                              |
| ---------------- | ----------------------------------------------------------------- |
| **Target**       | Select a saved VPS; _Inspect VPS_ is explicit and read-only       |
| **Mode**         | legacy / hybrid / managed, each with a plain-language explanation |
| **Drift**        | Plan vs reality, with **Adopt** / **Release** per resource        |
| **Connectivity** | Requirements, per-port verdict, _Open required ports_             |
| **Apply**        | Preview → per-operation risk → exact-name confirmation → apply    |

The renderer names a **target and an intent**. It never sends a command string, an
SSH credential, a host key or a private key, and never receives one.

### Deliberate absences — decisions, not omissions

- **No firewall close.** Opening is additive and cannot take away access that
  already works. Closing is a separate, deliberate act and does not belong behind
  a button on a summary screen.
- **No `refetchInterval`.** Drift and connectivity each open an SSH connection and
  run `docker inspect`. On a timer that is a background load on someone's
  production server for a page nobody is looking at.
- **No provider rules.** Reaching the cloud security list needs a credential this
  page does not hold, so every provider verdict is honestly `unknown`.

For legacy targets — which is every target until someone says otherwise — the
apply and open-ports surfaces are **not disabled; they are absent**.

### The policy test

`runtime-renderer-policy.test.ts` asserts the structural properties against the
source: no credential fields, no token literal, no apply while blockers stand,
exact-name confirmation for destructive operations, a preview dropped whenever the
plan under it moves, no polling, no close path.

The page was also registered in the existing `renderer-confirmation-policy` list,
which would otherwise have **silently stopped covering the newest destructive
surface**.

---

## Phase 9 — Cloudflare ownership, and the documentation

**Commits:** `aa74545`, `7028f31`

### 9a — DNS records CloudForge did not create

**File:** `packages/core/src/application/service-providers/cloudflare-dns-automation-service.ts`

`ensure()` found whatever A, AAAA or CNAME sat at the hostname, **overwrote it in
place**, and stamped `Managed by CloudForge` on it.

So configuring a pipeline for a domain that already served real traffic **silently
moved that traffic to the VPS** — and claimed the record on the way past. DNS has
no undo and no preview: by the time anyone noticed, resolvers worldwide had cached
the new answer. This violated requirement 20 (never silently claim ownership) and
requirement 19 (a connectivity-changing action with no confirmation).

Ownership is read from the **comment** field. Record tags would be neater but are
not available on every Cloudflare plan, and _a marker only some accounts can carry
is not a marker_.

Three outcomes now:

| Record state                        | Behaviour                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| Marked as ours, or absent           | Unchanged. Update or create.                                                                       |
| Unmarked, pointing **elsewhere**    | **Refused**, naming the address that is there, the address CloudForge wanted, and the two ways out |
| Unmarked, **already pointing here** | **Left entirely alone.** Nothing to change, and nothing to claim.                                  |

> Pointing the record at the VPS yourself, or deleting it, _in Cloudflare_, **is**
> the explicit adoption gesture — performed by the person who owns the record. That
> beats a checkbox in this app.

A CNAME does not qualify as "already pointing here" even when it resolves to the
right address, because whoever owns the target can repoint it without warning.

> **Two existing tests asserted the old behaviour**, using a fixture with an empty
> comment — the bug, encoded as a test. Their real intents (no plan-restricted
> tags; CNAME→A idempotency across repeated saves) are both about records
> CloudForge _wrote_, so the fixtures now say so and the assertions stand.

### 9b — Documentation

| Document                                         | Covers                                                          |
| ------------------------------------------------ | --------------------------------------------------------------- |
| [VPS-RUNTIME.md](VPS-RUNTIME.md)                 | The model, modes, ownership, adoption, preview/apply, firewalls |
| [RUNTIME-MIGRATION.md](RUNTIME-MIGRATION.md)     | What changes on an existing VPS (nothing), and how to verify it |
| [ANSIBLE.md](ANSIBLE.md)                         | Profile declarations, one firewall implementation               |
| [JENKINS-PIPELINES.md](JENKINS-PIPELINES.md)     | `HOST_PORT` is managed                                          |
| [CLOUDFLARE.md](CLOUDFLARE.md)                   | Records CloudForge did not create                               |
| [NGINX-MANAGER.md](NGINX-MANAGER.md)             | Containerised Nginx, the mount probe, the rollback              |
| [MODULES.md](MODULES.md), [README.md](README.md) | Indexed the new module and pages                                |

---

## What changes on a live server

**~80% of this branch is inert.** Every target starts `legacy`; no startup code
writes a plan; there is no database migration.

**Three behaviours change**, all in the direction of doing _less_:

1. **A pipeline whose DNS record you created by hand will refuse to save** until
   you point that record at the VPS in Cloudflare or delete it. _This is the one
   most likely to surprise you._
2. **`HOST_PORT` can no longer be typed at run time.** It never worked — it failed
   silently as a 502.
3. **The Ansible firewall task now actually opens the port** on nftables hosts, and
   the probe now reports firewall state correctly. Both may differ from what you
   saw before, because what you saw before was wrong.

---

## How to test

### The claim, verified

Before upgrading, on the VPS:

```sh
docker ps --format '{{.Names}}\t{{.Ports}}' | sort > /tmp/before.txt
docker network ls > /tmp/before-networks.txt
```

Use the app normally, then:

```sh
docker ps --format '{{.Names}}\t{{.Ports}}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt   # expect no output
docker network ls                     # expect no new networks
```

**An empty diff is the whole claim.**

### Per-phase checks

| Phase  | Check                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| **0**  | Open a domain in Nginx Manager → **Save** → `ls /etc/nginx/conf.d/` shows **exactly one** `cloudforge-*.conf` for it |
| **0**  | Enable SSL on a site with extra routes → the routes still answer over HTTPS                                          |
| **2**  | **Containers** lists everything, with Internal / Loopback / Public badges                                            |
| **4**  | **Ansible** profile states load and the firewall column matches reality                                              |
| **5b** | If your Nginx is a container: edit a site and save — it should now work rather than refuse                           |
| **6**  | On an nftables host, run the Jenkins or Nginx profile and confirm the port really opens (`nft list ruleset`)         |
| **7**  | **Jenkins → Run pipeline**: `HOST_PORT` is read-only and shows the pipeline's application port                       |
| **8**  | **VPS Runtime** → select a target → _Inspect VPS_ → reports `legacy`, no drift                                       |
| **9**  | A pipeline whose domain record you made by hand → **Save** → refuses with an actionable message                      |

The Phase 8 check is the important one: _a page that can change your topology,
telling you it is not going to_.

### Adopting a target, when you are ready

Nothing here is required. **Legacy mode is a valid permanent choice.**

1. **VPS Runtime → Inspect VPS.** Read what is there. Nothing is written.
2. **Switch to `hybrid`.** Only explicitly adopted resources become managed.
3. **Adopt one resource** from the drift table. Touches the VPS not at all.
4. **Preview.** Read the operations. A preview never changes anything.
5. **Apply** only if the operations are what you want.

Release is the inverse of adopt and is equally inert. Every step before apply is
undoable by pressing the other button — and apply shows you exactly what it will
do first.

### Rolling back

```sh
git checkout main && pnpm install && pnpm build
```

No database migration to reverse. A plan written by the newer build is an unread
row in `Setting` to the older one.

---

## Commit index

| Commit    | Phase | Files | Change         |
| --------- | ----- | ----- | -------------- |
| `f72bc8c` | 0–5a  | 65    | +11,293 / −984 |
| `3345554` | 4d    | 5     | +184 / −13     |
| `e1852b1` | 5a    | 2     | +52 / −6       |
| `8f53964` | 6     | 15    | +1,003 / −41   |
| `898fd84` | 7     | 4     | +460 / −33     |
| `aa74545` | 9a    | 2     | +217 / −4      |
| `19fc483` | 8     | 6     | +689           |
| `7028f31` | 9b    | 7     | +389           |
| `8dfc3ac` | 5b    | 5     | +303 / −17     |

---

## Verified negatives

Each of these was proved to be a real guard by breaking the code, watching the
test fail, and restoring it:

| Guard                                                          | Broke it →          |
| -------------------------------------------------------------- | ------------------- |
| Drift ownership / target-label check                           | 2 tests fail        |
| Preview fingerprint gate                                       | 1 test fails        |
| Route reachability rule                                        | 6 tests fail        |
| YAML block-scalar indentation                                  | 7 tests fail        |
| Jenkins trigger override (`HOST_PORT: '9999'` reaches Jenkins) | 2 tests fail        |
| Nginx rollback inode guard (`rm -rf /etc/nginx`)               | 1 test fails        |
| The `sh -n` harness itself                                     | proven able to fail |
