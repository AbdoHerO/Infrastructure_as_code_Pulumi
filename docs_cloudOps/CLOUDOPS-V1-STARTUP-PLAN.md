# CloudOps V1 — Startup Plan

| | |
|---|---|
| **Purpose** | Everything that must exist, be decided or be verified before CloudOps V1 is built and installed |
| **Status** | **PLAN — no implementation.** No CloudOps code exists. No server was contacted. No CloudForge file was modified. |
| **Date** | 2026-10-07 |
| **Follows** | `CLOUDOPS-ARCHITECTURE-DECISION.md` (D-22 **ACCEPTED**) and `CLOUDOPS-HANDOFF.md` |
| **Target server** | The existing `abdohero` VPS. Co-tenancy risk explicitly accepted by the owner. |
| **Target server** | **AMENDED 2026-10-07: a new, dedicated, clean VPS** — not `abdohero`. The co-tenancy acceptance is withdrawn. §20 and §21 are simplified accordingly; the items there that exist *only* because of shared tenancy are marked below |

### How to read this

Every item is in exactly one bucket:

| Bucket | Meaning |
|---|---|
| **NOW** | Needed before the first line of CloudOps code is written |
| **BEFORE INSTALL** | Needed before the agent first runs on `abdohero` |
| **LATER** | After V1 works, or a later phase |
| **OPTIONAL** | Genuine choice; V1 is complete without it |

**⬜ marks a decision that is yours.** They are collected in the checklist at the end.

### No values were invented

This plan contains **no** hostnames, tokens, passwords, paths or port numbers that were not either
verified on your systems or already proposed in the handoff and still marked PENDING. Anything not
yet decided appears as `⬜ owner decision` rather than a plausible-looking placeholder.

---

## Verified baseline

Facts, with where each came from. Nothing here is assumed.

| Fact | Value | Source |
|---|---|---|
| Instance | `abdohero` | Infrastructure plan, stack outputs |
| Shape | `VM.Standard.A1.Flex`, 2 OCPUs, 12 GB RAM | Infrastructure plan (owner-verified 2026-10-07) |
| Architecture | **aarch64 (ARM64)** | `uname` banner on the SSH session: `GNU/Linux 6.17.0-1011-oracle aarch64` |
| OS | Ubuntu 24.04.4 LTS | SSH login banner |
| Boot volume | 200 GB; **10.0 % of 192.69 GB used** (~173 GB free) | `free -h` session banner |
| Memory | 11 GiB total, 2.3 GiB used, **9.3 GiB available** | `free -h`, with all existing stacks running |
| **Swap** | **0 B** | `free -h` |
| Public IP | `84.8.217.33` | Stack outputs |
| SSH user | `ubuntu` | Stack outputs (`abdoheroSshUser`) |
| Open ingress (0.0.0.0/0) | TCP **22, 80, 443, 8080, 3000** | Firewall rules in the Infrastructure plan |
| Pending reboot | `*** System restart required ***` | SSH banner |
| Loopback ports already claimed | `8090` (lp-tifaw), `8091`/`8092` (interview-hub), `8100`/`8101`/`8102` (sm-erp), plus HanoutPlus's own | Compose files in this workspace |
| Co-tenants | Jenkins; HanoutPlus (Docker/Compose); lp-tifaw; interview-hub (incl. Qdrant); sm-erp (configured) | This workspace |

### Three observations that change the plan

**1. ARM64.** The Go agent must be built `GOOS=linux GOARCH=arm64`. Every package CloudOps depends
on — PHP, MySQL/MariaDB, Node — must have an arm64 build on Ubuntu 24.04. This is not a given for
third-party repositories and is an audit question (§3).

**2. Ubuntu, not Oracle Linux — so AppArmor, not SELinux.** The handoff's D-20 plans SELinux
labelling because it assumed Oracle Linux 9. Ubuntu 24.04 uses **AppArmor**. The mandatory-access-control
work is different, and in practice smaller: AppArmor profiles are path-based and the default Ubuntu
policy will not block CloudOps paths the way SELinux enforcing would. **D-20 needs restating for
Ubuntu.** Ubuntu 24.04 also ships **PHP 8.3 in its default repositories**, which satisfies current
Laravel without any third-party repository — a real simplification over the RHEL/Remi situation the
handoff worried about.

**3. Zero swap, and two ports open to the world.** With no swap, a Composer or npm build that
exceeds memory is OOM-killed, not slowed — which matters because the box now hosts other people's
production traffic (§20). Separately, **TCP 8080 and 3000 are open to `0.0.0.0/0`**. 8080 is
Jenkins. Neither is CloudOps' to change — the firewall is CloudForge-owned — but adding an
internet-facing panel to this server makes the existing exposure more consequential, and it belongs
in front of you before install (§21).

---

## 1. Prerequisites before development

| Bucket | Item |
|---|---|
| **NOW** | Create the `CloudOps` git repository, **private**, with `panel/`, `agent/`, `contracts/`, `docs/`, `scripts/` |
| **NOW** | Move the existing `E:\CloudOps` documents and `scripts/vps-audit.sh` into it as the first commit (they are currently not under version control) |
| **NOW** | `.gitattributes` pinning `*.sh`, `*.go`, `Dockerfile*`, `*.yml` to LF — the repository is edited on Windows and executed on Linux |
| **NOW** | `.gitignore` covering `.env`, `*.env.production`, agent config, audit reports, `vendor/`, `node_modules/`, build output |
| **NOW** | Local toolchain: PHP 8.3+, Composer, Go (⬜ version), Node LTS |
| **NOW** | ⬜ **Confirm D-13** (Laravel panel + Go agent) — recommended in the decision document, not yet accepted |
| **BEFORE INSTALL** | A **disposable Ubuntu 24.04 ARM64 VM** for every destructive test. Not optional in substance: `abdohero` runs production traffic |
| **LATER** | CI: `golangci-lint` + `go test` for the agent, Pint/PHPStan/Pest for the panel |
| **OPTIONAL** | A local VM mirroring the co-tenancy (Docker + a dummy Nginx site) to rehearse conflict detection |

## 2. Prerequisites before first installation on `abdohero`

Ordered. Each line is a gate, not a suggestion.

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | The read-only VPS audit has been **run and read** (§3) |
| **BEFORE INSTALL** | A **fresh, restore-tested backup of every existing stack** — HanoutPlus, lp-tifaw, interview-hub, sm-erp — taken and verified off-server |
| **BEFORE INSTALL** | ⬜ **D-19 decided**: who installs PHP, MySQL, Composer, Node |
| **BEFORE INSTALL** | ⬜ **D-15 decided**: the CloudOps base directory (handoff proposes `/srv/cloudops/`; PENDING) |
| **BEFORE INSTALL** | The agent's **deny list implemented and tested** — every CloudForge path, label and marker (§21) |
| **BEFORE INSTALL** | The full install rehearsed end-to-end on the disposable VM, including uninstall |
| **BEFORE INSTALL** | A written, tested **uninstall/rollback procedure** that returns the server to its pre-CloudOps state |
| **BEFORE INSTALL** | The pending OS reboot taken at a quiet moment, so a kernel update is not entangled with the install |
| **BEFORE INSTALL** | Agreement on what "stop" looks like: a named signal that aborts the install and reverts |

## 3. VPS audit requirements

The audit has **never been run**. It is the gate for D-11, D-14, D-15, D-20, PHP versions and sizing.

| Bucket | Item |
|---|---|
| **NOW** | Review `scripts/vps-audit.sh` v1.1 as source — it is syntax-checked and WSL-tested, never run against a real server with root |
| **BEFORE INSTALL** | ⬜ **Owner runs it**, read-only, output to the workstation, nothing written on the server |
| **BEFORE INSTALL** | It must answer: which process owns :80/:443; is Nginx native or containerised; the full `server_name` inventory tagged by owner; whether `include conf.d/*.conf` is present in `nginx.conf`; whether MySQL/MariaDB exists and on which port; installed PHP; Node/Composer presence; AppArmor status; **arm64 package availability** for any third-party repo under consideration; free disk and inode counts; what is listening on 3000 |
| **BEFORE INSTALL** | Record the result in the CloudOps repository as the infrastructure-audit document, with the date |
| **LATER** | Re-run after any CloudForge infrastructure change, and compare |

**The audit must not be run by me without your instruction**, and this plan does not run it.

## 4. Domain / subdomain requirements

| Bucket | Item |
|---|---|
| **NOW** | ⬜ **Panel hostname** — not chosen. It determines the Cloudflare Access application and the panel's Nginx site |
| **BEFORE INSTALL** | ⬜ Which zone the panel hostname lives in (you have 4 Cloudflare zones; `zincolo.com` and `tujjar.store` are known) |
| **BEFORE INSTALL** | Confirm the chosen hostname is **not already served** by any Nginx `server_name` on the box — the audit answers this |
| **BEFORE INSTALL** | Rule: a hostname belongs to exactly one product. CloudForge currently owns `tujjar.store`, `interview.zincolo.com`, and (when deployed) `api/dash/www.zincolo.com` |
| **LATER** | Per-application hostnames, created as applications are created |
| **OPTIONAL** | A dedicated zone for CloudOps-hosted applications, to make the ownership split visible in Cloudflare itself |

## 5. Cloudflare requirements

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | ⬜ **A new, separate API token for CloudOps** (D-21). Scopes: Zone Read, DNS Read, SSL and Certificates Edit; **Zone Resources restricted** to the zones CloudOps will serve. Do **not** reuse `cloudforge-hanoutplus-production` |
| **BEFORE INSTALL** | The token is stored **only** in the agent configuration on the server, root-owned `0600`. Never in the panel, never in the repository |
| **BEFORE INSTALL** | ⬜ **D-26 — panel access method.** Recommended: Cloudflare Access. Requires an Access application and a policy allowing your identity |
| **BEFORE INSTALL** | Understand the interaction: CloudForge sets zones to **Full (strict)**. A CloudOps hostname on a proxied record without a valid origin certificate returns **526**. Certificate before live, always |
| **LATER** | ⬜ Whether CloudOps creates its own DNS records (marked `Managed by CloudOps`) or you create them. V1 proposal: you create them; CloudOps only reads |
| **OPTIONAL** | Separate Access policies per application for future team members |

## 6. GitHub / Git repository requirements

| Bucket | Item |
|---|---|
| **NOW** | The `CloudOps` repository, **private** |
| **NOW** | ⬜ Branch strategy (`main` only, or `main` + feature branches) |
| **BEFORE INSTALL** | Per-application **read-only deploy keys**, generated on the server, private half never leaving it |
| **BEFORE INSTALL** | ⬜ Webhook strategy: which provider signature scheme, and the public path the webhook endpoint is reachable at |
| **BEFORE INSTALL** | Webhook secrets generated per application, stored encrypted in the panel |
| **LATER** | CI publishing agent binaries as release artifacts (`linux/arm64` at minimum) |
| **OPTIONAL** | Signed agent binaries / checksums published with each release |

## 7. SSH and security requirements

| Bucket | Item |
|---|---|
| **NOW** | **CloudOps holds no SSH credentials.** Server access stays with CloudForge. The agent is local to its host and is not an SSH client |
| **BEFORE INSTALL** | Agent socket at a CloudOps-owned path, `root:cloudops 0660`, caller identity verified by **peer credentials** — not by a shared secret |
| **BEFORE INSTALL** | The panel's Linux user has **no sudo**, no shell, and — critically — **is not in the `docker` group**. Docker group membership is equivalent to root on this box |
| **BEFORE INSTALL** | The agent is **never** reachable over TCP in V1 |
| **LATER** | Mutual TLS + enrollment tokens for multi-server (§17 of the decision document) |
| **OPTIONAL** | A dedicated SSH key for your own administrative access to CloudOps paths, separate from CloudForge's |

## 8. Database requirements

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | ⬜ **D-11**: MySQL/MariaDB native on the host, or containerised. Audit input required. Note HanoutPlus already runs MySQL **inside its own container**, so a host instance does not necessarily conflict — the audit must confirm nothing publishes 3306 on the host |
| **BEFORE INSTALL** | ⬜ **D-19**: who installs it |
| **BEFORE INSTALL** | A restricted admin account for the agent, able to act **only** on CloudOps-namespaced databases and users. Credentials in the agent configuration only |
| **BEFORE INSTALL** | ⬜ **D-27**: the panel's own database — MySQL/MariaDB or SQLite |
| **BEFORE INSTALL** | Namespacing rule agreed (handoff proposes `co_` prefix for databases and users; PROPOSED) |
| **LATER** | Per-application database backups with retention (§9) |
| **OPTIONAL** | A separate MySQL instance or port for CloudOps, if the audit shows a host instance already in use |

## 9. Backup requirements

Raised in priority by the decision document: **this is the highest-consequence gap.**

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | **Back up the existing stacks first** — this is the single most important line in this plan. Volumes and databases for HanoutPlus, lp-tifaw, interview-hub, sm-erp |
| **BEFORE INSTALL** | ⬜ **Off-server backup destination** (D-23) — where, with what credentials, and who holds the encryption key |
| **BEFORE INSTALL** | A **proven restore**, not a proven backup. An untested backup is a hypothesis |
| **LATER** | Scheduled per-application backups: database dump + `shared/` tree, encrypted before leaving the server |
| **LATER** | ⬜ Retention policy |
| **LATER** | CloudForge change **F2**: warn before replace/destroy when a CloudOps manifest is present. Pulumi replaces an Oracle instance on immutable-metadata change, and the boot volume goes with it |
| **OPTIONAL** | Periodic automated restore verification into a scratch database |

## 10. Secrets and credentials requirements

| Bucket | Item |
|---|---|
| **NOW** | The boundary, written down and testable: CloudOps holds **no** cloud provider credentials, **no** SSH keys, and **not** CloudForge's Cloudflare token |
| **BEFORE INSTALL** | Agent configuration (root `0600`): CloudOps Cloudflare token, MySQL admin credentials. Nothing else |
| **BEFORE INSTALL** | Panel database encryption at rest for application secrets, environment variables and webhook secrets |
| **BEFORE INSTALL** | Masking rule: secrets never appear in logs, deployment output, audit entries, the manifest, error messages or API responses |
| **NOW** | **A canary test in CI from the first commit** — inject a known secret, assert it appears in no output stream. Retrofitting this is how secrets leak |
| **LATER** | ⬜ Rotation procedure for the Cloudflare token and MySQL admin credentials |
| **OPTIONAL** | A secrets manager rather than files on disk |

## 11. Laravel (panel) requirements

| Bucket | Item |
|---|---|
| **NOW** | ⬜ Confirm Laravel for the panel (D-13) |
| **NOW** | ⬜ Laravel and PHP version for the panel itself — distinct from the PHP versions it *manages* |
| **BEFORE INSTALL** | Authentication with **mandatory TOTP 2FA** and rate-limited login (D-25 ACCEPTED) |
| **BEFORE INSTALL** | The panel runs as its own unprivileged Linux user, with no sudo and no shell |
| **BEFORE INSTALL** | The webhook endpoint is the **only** public route; signature-verified, replay-rejected, rate-limited |
| **BEFORE INSTALL** | The panel's own queue and scheduler, running as the panel user, driving agent operations |
| **LATER** | Application CRUD, deployment history, log viewer, file manager |
| **OPTIONAL** | Inertia/React versus Blade/Livewire for the UI |

## 12. Go agent requirements

| Bucket | Item |
|---|---|
| **NOW** | ⬜ Confirm Go, and the Go version (D-13) |
| **NOW** | **Build target `GOOS=linux GOARCH=arm64`** — verified from the server's `aarch64` kernel |
| **NOW** | The **operation catalogue** written before any operation is implemented. Adding an operation means amending the catalogue and its tests |
| **NOW** | Hard rule, enforced by a test: **no generic "run command" operation, ever** (R-02 REJECTED). Commands are built as argument arrays, never string concatenation |
| **BEFORE INSTALL** | Every parameter re-validated at the agent, even when the panel validated it |
| **BEFORE INSTALL** | Deny list enforced at the agent, with a test per denied path/label |
| **BEFORE INSTALL** | Audit log: time, panel user, operation, masked parameters, result, duration — root-only, mirrored to the panel |
| **BEFORE INSTALL** | systemd unit, restart policy, and resource limits (§20) |
| **BEFORE INSTALL** | Manifest writer — read-only, **no secrets**, schema-versioned |
| **LATER** | mTLS transport for multi-server; the catalogue must stay transport-independent from day one |
| **OPTIONAL** | A `--dry-run` mode that prints the exact commands an operation would run |

## 13. Nginx ownership and integration

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | Audit confirms **native host Nginx owns :80/:443** (D-14). CloudOps sites reach PHP-FPM over Unix sockets, which a containerised Nginx cannot |
| **BEFORE INSTALL** | Audit confirms `nginx.conf` contains `include /etc/nginx/conf.d/*.conf;` |
| **BEFORE INSTALL** | ⬜ Your approval to install **exactly one file** inside CloudForge territory: a `zz-`-prefixed include in `conf.d` pointing at the CloudOps directory (D-17). The `zz-` prefix is load-bearing — `conf.d/*.conf` loads alphabetically, so CloudOps lands last and cannot shadow a CloudForge site |
| **BEFORE INSTALL** | Everything else — sites, snippets, certificates — outside `/etc/nginx`, where CloudForge's archives and restores never reach |
| **BEFORE INSTALL** | Per-file atomic writes (temp file, rename), `nginx -t` before every reload, own change removed on failure, graceful reload. **Deliberately not** CloudForge's whole-directory transaction |
| **BEFORE INSTALL** | Agent verifies the include file exists on **every** operation and health check. A CloudForge restore older than the CloudOps install is the one realistic way every CloudOps site stops being served at once |
| **BEFORE INSTALL** | Hostname conflict detection scans **every** `server_name` on the host, CloudForge's included, and refuses a hostname served elsewhere |
| **LATER** | ⬜ CloudForge change **F3**: a shared `flock` around Nginx mutations, closing the concurrent-edit window |

## 14. PHP / PHP-FPM strategy

| Bucket | Item |
|---|---|
| **NOW** | ⬜ **Which PHP versions must be supported.** Ubuntu 24.04 ships 8.3 by default |
| **BEFORE INSTALL** | If more than one version is needed: ⬜ which repository provides them, **and whether it publishes arm64 builds** — this must be verified, not assumed |
| **BEFORE INSTALL** | ⬜ **D-05**: a CloudOps-owned PHP-FPM master per version, so a pool reload never interrupts an unrelated PHP service |
| **BEFORE INSTALL** | One pool per application, running as that application's user, `open_basedir` confined to its directory |
| **BEFORE INSTALL** | ⬜ **D-09**: deployments do not reload PHP-FPM; Nginx passes `$realpath_root` so each release has distinct paths and OPcache never serves the previous release |
| **BEFORE INSTALL** | Pool process manager set to `ondemand` by default — idle applications must not hold memory on a shared box (§20) |
| **LATER** | Per-application extension sets |
| **OPTIONAL** | Per-application PHP INI overrides in the panel |

## 15. MySQL / MariaDB strategy

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | ⬜ **D-11** — native vs container; and if native, ⬜ MySQL or MariaDB |
| **BEFORE INSTALL** | Bound to localhost only. No port published to the internet |
| **BEFORE INSTALL** | Namespacing agreed, so CloudOps databases and users are recognisable at a glance and the admin account can be scoped to them |
| **BEFORE INSTALL** | Admin account restricted to the CloudOps namespace — it must **not** be `root` |
| **BEFORE INSTALL** | Confirm no conflict with HanoutPlus's containerised MySQL (audit) |
| **BEFORE INSTALL** | Memory configuration sized for a **shared** box, not a dedicated one (§20) |
| **LATER** | Per-application database backups, restore into a scratch database |
| **OPTIONAL** | A read-only account per application for reporting |

## 16. Node / npm / Composer strategy

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | ⬜ Node version, and ⬜ who installs it (D-19) |
| **BEFORE INSTALL** | Composer installed system-wide, invoked **as the application user**, never root |
| **BEFORE INSTALL** | **The agent must not depend on either.** This is the reason the agent is a static binary: CloudOps upgrades Node and PHP, and must not break the thing performing the upgrade |
| **BEFORE INSTALL** | Builds run as the application user, inside its directory, with a concurrency cap (§20) |
| **LATER** | Per-application Node version selection |
| **OPTIONAL** | A shared Composer/npm cache, weighed against cross-application isolation |

## 17. Queue workers and cron strategy

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | ⬜ **D-08**: queue workers as systemd units rather than Supervisor. Note this differs from HanoutPlus, which runs Supervisor **inside its container** — that is CloudForge's and stays as it is |
| **BEFORE INSTALL** | One unit per application worker, running as the application user, with resource limits (§20) |
| **BEFORE INSTALL** | Graceful restart on deploy: `SIGTERM`, finish the current job, restart from the new release. **After** the symlink switch, because workers load code from `current` |
| **BEFORE INSTALL** | Scheduler entry per application, as the application user, in a CloudOps-owned cron location |
| **LATER** | Horizon support; worker concurrency controls in the panel |
| **OPTIONAL** | Per-queue workers rather than one per application |

## 18. Release and rollback strategy

Specified in handoff §13–14 and **ACCEPTED** (D-06, D-06a). Restated here as build requirements.

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | `releases/`, `current` symlink, `shared/` for `.env` and `storage/` |
| **BEFORE INSTALL** | Atomic switch: new symlink under a temporary name, then renamed over `current` |
| **BEFORE INSTALL** | **Pre-switch** health check against the new release through its own pool, before it is public |
| **BEFORE INSTALL** | **Post-switch** health check through Nginx, with retries, and automatic revert on failure |
| **BEFORE INSTALL** | `key:generate` **only at creation** (R-03 REJECTED). `migrate --force` only when explicitly enabled, off by default. `migrate:fresh`, `migrate:reset`, `db:wipe` never run by a deployment |
| **BEFORE INSTALL** | Per-application deployment lock — one at a time |
| **BEFORE INSTALL** | Retention: keep N releases (proposal 5); never delete the live or previous release |
| **BEFORE INSTALL** | Databases are **never** rolled back. Migrations must be backward-compatible with the previous release |
| **LATER** | Deploy hooks, owner-defined, run as the application user |

## 19. Logging and monitoring requirements

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | Per-application Nginx and PHP-FPM logs under that application's directory |
| **BEFORE INSTALL** | **Log rotation configured from day one.** On a shared 200 GB volume, unrotated logs are how one application takes down four others |
| **BEFORE INSTALL** | Agent audit log, root-only, rotated |
| **BEFORE INSTALL** | Deployment logs stored per deployment, masked |
| **LATER** | Disk, memory and certificate-expiry alerting |
| **LATER** | Application health monitoring with history |
| **OPTIONAL** | Shipping logs off-server |

## 20. Resource and disk safeguards for the shared VPS

**This section exists because of the accepted co-tenancy risk.** The purpose is not to make CloudOps
fast; it is to make it **incapable of starving the applications already on the box**.

| Bucket | Item |
|---|---|
| **BEFORE INSTALL** | **systemd resource control on every CloudOps unit** — agent, PHP-FPM masters, queue workers: `MemoryMax`, `CPUQuota`, `TasksMax`. Defaults chosen against the 12 GB total with ~9.3 GiB currently free, leaving explicit headroom for the existing stacks |
| **BEFORE INSTALL** | **Build concurrency capped at one** for V1. Composer and npm are the memory spikes, and **there is no swap** — an overcommit is an OOM kill, and the kernel may not choose CloudOps' process |
| **BEFORE INSTALL** | PHP-FPM pools `ondemand` with conservative `pm.max_children`, so idle applications hold no memory |
| **BEFORE INSTALL** | A **disk floor**: the agent refuses to start a deployment when free space is below a threshold, rather than filling the volume shared with four stacks and Qdrant |
| **BEFORE INSTALL** | Release retention enforced by the agent, not by hope |
| **BEFORE INSTALL** | A documented emergency stop: how to stop all CloudOps units without touching anything CloudForge owns |
| **LATER** | ⬜ Per-application quotas |
| **LATER** | Trend monitoring for disk and memory, to see the move to a dedicated VPS coming before it is urgent |
| **OPTIONAL** | Filesystem quotas per application user |

Two numbers to watch, from the verified baseline: **memory headroom** (9.3 GiB free today) and
**disk** (~173 GB free, before release history, Docker images and Qdrant grow).

## 21. Security isolation between CloudOps and existing applications

| Bucket | Item |
|---|---|
| **NOW** | **The deny list, written as code with a test per entry** — not as prose. At minimum: `/etc/nginx` (except the single include file), CloudForge's own directories, Docker and Jenkins resources, any Nginx file not written by CloudOps, any DNS record not marked as CloudOps', any container, image, network or volume |
| **NOW** | A test asserting the agent **refuses** each denied target, and that the refusal is audited |
| **BEFORE INSTALL** | One Linux user and group per application; no application can read another's directory |
| **BEFORE INSTALL** | `open_basedir` per pool; file-manager paths resolved to a real path that must stay inside the application directory, symlinks leading outside refused |
| **BEFORE INSTALL** | Panel user: no sudo, no shell, **not in the `docker` group** |
| **BEFORE INSTALL** | Agent socket permissions and peer-credential verification tested, including a negative test from an unauthorised user |
| **BEFORE INSTALL** | AppArmor posture for Ubuntu decided — **not** the SELinux plan in D-20 |
| **BEFORE INSTALL** | **Raise with you, before install:** TCP **8080** and **3000** are open to `0.0.0.0/0`. 8080 is Jenkins. These are CloudForge-owned firewall decisions and CloudOps will not change them, but adding an internet-facing panel to this server makes them worth a deliberate look |
| **LATER** | Periodic conflict scan: hostnames, ports, Nginx files, DNS records |
| **OPTIONAL** | A read-only CloudOps mode for inspection without any write capability |

## 22. First milestones, in implementation order

Each milestone ends in something demonstrable. **Nothing touches `abdohero` before M7.**

| # | Milestone | Done when | Bucket |
|---|---|---|---|
| **M0** | Repository created; documents and audit script committed; CI skeleton | CI green on an empty project | **NOW** |
| **M1** | `contracts/`: manifest schema, prerequisites schema, ownership and deny-list specification | Schemas validate fixtures on both sides | **NOW** |
| **M2** | Agent skeleton: socket, peer credentials, audit log, **operation catalogue with zero privileged operations** | Panel can call `ping`; an unauthorised caller is refused and audited | **NOW** |
| **M3** | Agent: prerequisites check and manifest writer, both **read-only** | Runs on the disposable VM, writes a valid manifest, changes nothing | **NOW** |
| **M4** | Deny list implemented, with a test per entry | Every denied target refused and audited | **NOW** |
| **M5** | First privileged operations on the **disposable VM**: application user, directory layout, PHP-FPM pool, Nginx site + include file, `nginx -t`, graceful reload | A static page served on the VM through a CloudOps-owned site | **BEFORE INSTALL** |
| **M6** | Uninstall procedure: removes every CloudOps resource, leaves the rest untouched | VM returns to its pre-CloudOps state, verified by diff | **BEFORE INSTALL** |
| **M7** | ⬜ **Audit `abdohero`**, back up every existing stack, then install the agent in **read-only mode only** | Manifest and prerequisites report produced; `docker ps`, Nginx sites and certificates unchanged | **BEFORE INSTALL** |
| **M8** | Panel: auth + 2FA, application records, agent client, behind the chosen access method | Sign in, list applications (empty) | **BEFORE INSTALL** |
| **M9** | Deployment pipeline: releases, shared state, health checks, atomic switch, automatic revert | A throwaway Laravel application deploys and rolls back **on the VM** | **BEFORE INSTALL** |
| **M10** | Certificates, database creation, workers, cron | Full lifecycle on the VM | **LATER** |
| **M11** | Backups with off-server copies **and a proven restore** | A deliberate restore succeeds | **LATER** |
| **M12** | ⬜ First real application on `abdohero`, alongside the existing stacks | Serving, with the other four stacks unaffected | **LATER** |

**M7 is the first contact with your production server, and it is read-only.** The first write to
`abdohero` is M12, and it is gated on your explicit approval.

---

## Decisions that still require your approval

Nothing below has been decided. **D-22 is the only one that moved** (ACCEPTED 2026-10-07).

### Blocking — needed before code is written

| ⬜ | ID | Decision |
|---|---|---|
| ⬜ | **D-13** | Laravel panel + Go agent. Recommended; not confirmed |
| ⬜ | — | Go version; Laravel and PHP version for the panel itself |
| ⬜ | — | Branch strategy for the CloudOps repository |

### Blocking — needed before the first install on `abdohero`

| ⬜ | ID | Decision |
|---|---|---|
| ⬜ | **D-19** | Who installs PHP, MySQL/MariaDB, Composer, Node — a CloudForge Ansible profile (F1) or documented manual setup. **The next decision after the audit** |
| ⬜ | **D-11** | MySQL/MariaDB native or containerised; MySQL or MariaDB |
| ⬜ | **D-14** | Confirmed by audit: host Nginx owns :80/:443 |
| ⬜ | **D-15** | CloudOps base directory |
| ⬜ | **D-20** | Supported OS families — **and the AppArmor posture for Ubuntu**, replacing the SELinux plan |
| ⬜ | **D-26** | Panel access method. Cloudflare Access recommended |
| ⬜ | **D-27** | Panel database: MySQL/MariaDB or SQLite |
| ⬜ | **D-23** | Off-server backup destination, retention, and who holds the encryption key |
| ⬜ | — | Supported PHP versions, and whether a third-party repository with **verified arm64 builds** is needed |
| ⬜ | — | The panel hostname and its zone |
| ⬜ | — | Approval to install the single `zz-` include file in `/etc/nginx/conf.d` (D-17) |
| ⬜ | — | Node version |
| ⬜ | — | Approval to run the read-only VPS audit |

### Confirmations of things recommended but not yet accepted

| ⬜ | ID | Decision |
|---|---|---|
| ⬜ | D-02 | No Reverse-proxy application type in CloudOps |
| ⬜ | D-05 | CloudOps-owned PHP-FPM master per version |
| ⬜ | D-08 | Queue workers as systemd units |
| ⬜ | D-09 | No PHP-FPM reload on deploy; `$realpath_root` |
| ⬜ | D-10 | Origin CA for proxied hostnames, Let's Encrypt for DNS-only |
| ⬜ | D-17 | CloudOps Nginx files outside `/etc/nginx` |
| ⬜ | D-18 | No runtime dependency on CloudForge |
| ⬜ | D-21 | Separate narrow Cloudflare token |

### CloudForge changes — none required for V1

| ⬜ | ID | Change |
|---|---|---|
| ⬜ | F1 | Ansible profile installing the hosting stack — only if D-19 says CloudForge installs it |
| ⬜ | F2 | Warn before replace/destroy when a CloudOps manifest exists |
| ⬜ | F3 | Shared `flock` around Nginx mutations |
| ⬜ | F4 | Read-only "Hosting" panel in CloudForge reading the manifest |
| ⬜ | — | Fix `docs/FIRST-INSTANCE.md`, which describes this server with six stale facts |

---

## What this plan does not do

- No CloudOps code was created.
- No CloudForge file was modified.
- No server was contacted; the VPS audit was **not** run.
- Nothing was installed.
- No PROPOSED or PENDING decision was turned into ACCEPTED, other than D-22, which you accepted.

**Next step is yours:** work through the blocking checklist above, starting with **D-13** and
**approval to run the audit**.
