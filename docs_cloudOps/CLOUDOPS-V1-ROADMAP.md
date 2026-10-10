# CloudOps V1 — Project-Start Roadmap

| | |
|---|---|
| **Question answered** | *What exactly do we need to do next to start building CloudOps?* |
| **Status** | **PLAN ONLY.** Nothing implemented, installed or modified. Awaiting owner approval |
| **Date** | 2026-10-07 |
| **Target** | `always-free-arm` · `51.170.131.166` · Ubuntu 24.04 ARM64 · 2 OCPU · 12 GB · 191 GB free |
| **Accepted** | D-22 (separate repository, this VPS), D-13 (Laravel panel + Go agent) |
| **Blocking** | **D-19 and five sub-decisions — §A below** |

**RECOMMENDED** below means: supported by evidence, awaiting your approval. Nothing in this document
is ACCEPTED on its own.

---

## Current state, verified

| | |
|---|---|
| Nginx | **Installed and active**, 1.24.0, listening on :80 (v4 + v6) |
| Host firewall | **22 and 80 open**; 443 closed; `iptables-nft`; default reject |
| OCI ingress | 22, 80, 443 |
| Installed | git 2.43.0, nginx |
| **Not installed** | Docker, Jenkins, PHP, PHP-FPM, MySQL/MariaDB, Node, npm, Composer |
| `/srv`, `/opt` | Exist, empty. `/var/www` created by nginx |
| `/etc/cloudops` | Absent |
| Swap | **None** |
| CloudOps code | **None** |

### Package versions actually available (Ubuntu 24.04 repos, verified)

| Package | Candidate | Verdict |
|---|---|---|
| `php8.3-fpm` / `php8.3-cli` | **8.3.6** | ✅ Covers Laravel 11, 12 and 13 |
| `mysql-server` | **8.0.46** | ✅ |
| `mariadb-server` | **10.11.14** | ✅ |
| `composer` | **2.7.1** | ✅ (official installer is newer) |
| `certbot` | **2.9.0** | ✅ **Let's Encrypt works natively — no Docker needed** |
| `redis-server` | 7.0.15 | Available, not needed for V1 |
| `nodejs` / `npm` | **18.19.1 / 9.2.0** | ⚠️ **Node 18 is EOL (April 2025).** Insufficient for modern Vite/Laravel builds |

**Correction to earlier advice:** I previously said Let's Encrypt was unavailable on this box because
CloudForge's issuance requires Docker. That is true of *CloudForge's* path only. `certbot` is in
Ubuntu's repositories, so **CloudOps can do Let's Encrypt natively**. This materially widens the
SSL options in §C.

---

# A. D-19 — who installs and owns the hosting stack

The question covers PHP, PHP-FPM, MySQL/MariaDB, Composer and Node.

### The distinction that resolves it

"Install" conflates two different things, and the ownership rule should split between them, not along
who runs `apt`:

| Layer | Example | Natural owner |
|---|---|---|
| **Packages** — shared, OS-level, one per host | the `php8.3-fpm` binary, the MySQL server | Infrastructure |
| **Configuration** — per application, many per host | a PHP-FPM pool, a database, a Linux user, an Nginx site | CloudOps |

Nobody disputes the second. D-19 is only about the first.

### Option A — CloudForge Ansible profile

| | |
|---|---|
| **For** | CloudForge is the documented owner of OS packages and already has its Ansible runtime on this box. Idempotent, repeatable on future servers, integrates with preflight and host-firewall handling. One package authority |
| **Against** | Requires **changing a released product**: `ansible-playbooks.ts` is TypeScript strings in CloudForge, so a new profile is a commit, a test pass and a release. It breaks the architecture decision's strongest property — *CloudForge needs no change for CloudOps V1*. Worse, you would be writing that profile **before you know what the stack actually needs**, then amending a released app each time you learn something |

### Option B — CloudOps installs it

| | |
|---|---|
| **For** | No CloudForge change; CloudOps evolves independently |
| **Against** | **Violates the agent's foundational rule.** The agent must never install packages — a root daemon that can `apt install` can install anything, and that is most of the value of an allowlisted catalogue. It also creates a second package authority on a host CloudForge manages |

### Option C — Hybrid

| | |
|---|---|
| **For** | Packages stay conceptually infrastructure; CloudOps owns everything configured on top |
| **Against** | "Hybrid" alone does not say *who types the command* for V1 |

### RECOMMENDED — Option C, phased in time

> **V1: a versioned bootstrap script, living in the CloudOps repository, reviewed by you and run by
> you over SSH. Not by the agent. Not by CloudForge.**
>
> **V1.x: promote that proven script into a CloudForge Ansible profile (F1)** once the stack's shape
> has stopped changing.
>
> **Always: the agent never installs a package.** It checks the prerequisites contract and reports
> what is missing.

Why this and not A:

1. **You do not yet know the final shape of the stack.** A bootstrap script is cheap to change; a
   CloudForge Ansible profile costs a commit and a release each time.
2. **Installation is a one-time act, not a runtime dependency** — so CloudForge not always running
   is irrelevant here. D-18 is untouched.
3. **It keeps CloudForge at zero changes for V1**, which was the decisive property of the accepted
   architecture.
4. **Converting a proven script into an Ansible profile later is mechanical.** Discovering
   requirements by repeatedly editing a released desktop app is not.
5. **The agent's no-install rule survives intact**, because the owner runs the script, not the agent.

Ownership after installation: **the infrastructure layer owns the packages.** For V1 you act as that
layer; `unattended-upgrades` handles security patching. CloudOps owns only what it configures.

## A.1 — One PHP version or several?

**RECOMMENDED: install one — PHP 8.3 from Ubuntu's own repositories. Design for several.**

- 8.3.6 is in the base repos: no third-party source, no arm64 uncertainty, no added trust.
- It covers Laravel 11, 12 and 13 (13 requires 8.3+).
- Multiple versions means the `ondrej/php` PPA, whose arm64 coverage is **[NOT INSPECTED]** — and
  cannot be inspected without adding a repository, which is a write.

The nuance that matters: **design for N, install 1.** From the first migration the application record
carries a `php_version` column, pool paths are versioned (`/etc/cloudops/php/8.3/`), socket names
include the version, and the agent's pool operations take a version parameter. Adding 8.4 later is
then additive, not a redesign.

## A.2 — MySQL or MariaDB?

Both are in the base repos; both work with Laravel; both are fine on arm64.

| | MySQL 8.0.46 | MariaDB 10.11.14 |
|---|---|---|
| Memory at rest | Heavier (performance_schema ~400 MB; tunable) | Lighter by default |
| Your existing apps | **lp-tifaw and HanoutPlus both run MySQL 8.0** | — |
| Future migration of those apps | Like-for-like | MySQL→MariaDB is usually fine, with edge cases in JSON and collations |

**RECOMMENDED: MySQL 8.0 — weakly held.** The deciding factor is not technical merit but
**operator familiarity and migration compatibility** with the applications you already run. Memory is
not a real constraint on 12 GB, and `performance_schema=OFF` recovers most of the difference.

If you would rather optimise for a lean footprint, MariaDB is a defensible choice and nothing in the
design depends on which you pick. **Your call.**

## A.3 — Node: global or per application?

Ubuntu ships **Node 18, which is end-of-life**. It cannot build a current Laravel front-end. So this
is not "global vs per-app" — it is first "where does a supported Node come from".

| Option | Assessment |
|---|---|
| Ubuntu's Node 18 | **Not viable** — EOL, and modern Vite requires 20+ |
| **NodeSource repo, Node 22 LTS, global** | One third-party apt source; publishes arm64; simple; **RECOMMENDED for V1** |
| `fnm`/`nvm` per application user | Enables per-app versions with no root at all, fits CloudOps' model well — but adds a build-step indirection and a per-user install |

**RECOMMENDED: one global Node 22 LTS via NodeSource for V1**, with the application record carrying a
nullable `node_version` so per-app support is additive later. Verify NodeSource's arm64 packages on
the box before committing.

Note Node is a **build-time** dependency only — PHP/Laravel applications do not need it at runtime.

## A.4 — Composer: global or controlled?

Low tension. **RECOMMENDED: a single global binary at `/usr/local/bin/composer`, always executed as
the application's Linux user, with `COMPOSER_HOME` set inside that application's directory** so
caches, auth tokens and plugins are per-application rather than shared.

Use the official installer rather than the Ubuntu package, so Composer can self-update independently
of the distribution.

---

# B. Minimum infrastructure for a first working CloudOps V1

### MINIMUM — V1 cannot work without these

| | Component | State |
|---|---|---|
| 1 | Native Nginx owning :80/:443 | ✅ **Done** (80 open; 443 per §C) |
| 2 | PHP 8.3 CLI + FPM + extensions | ❌ |
| 3 | MySQL 8.0 (or MariaDB), localhost-bound | ❌ |
| 4 | Composer | ❌ |
| 5 | Node 22 LTS | ❌ |
| 6 | git | ✅ **Present** |
| 7 | `/srv/cloudops` directory layout | ❌ |
| 8 | `cloudops-agent` binary + systemd unit + socket | ❌ |
| 9 | Panel (Laravel) + its own database | ❌ |
| 10 | One `zz-cloudops.conf` include in `/etc/nginx/conf.d/` | ❌ |
| 11 | A panel hostname, DNS record and certificate | ❌ |
| 12 | 443 open | ❌ — §C |
| 13 | Swap | ❌ — builds on a swapless box are OOM-killed, not slowed |

### LATER — V1 is complete without them

Multiple PHP versions · Redis · Horizon and Reverb support · a file manager · monitoring and alerting
· multi-server and mTLS · per-application resource quotas · Let's Encrypt for DNS-only hostnames ·
promoting the bootstrap script to a CloudForge Ansible profile (F1) · CloudForge reading the manifest
(F4) · migrating any existing Docker/Jenkins application.

### Deliberately never on this server

Docker · Jenkins · Dockhand · Portainer · PostgreSQL. The absence of Docker is a security property:
no root-equivalent group, and no DNAT path that bypasses the host firewall — which is exactly how
`dockhand` became publicly reachable on the other server despite its firewall rejecting that port.

---

# C. Port 443 and SSL — the correct handling

### When should 443 be opened?

**At the moment the first hostname that terminates TLS exists — not before.** CloudForge's own rule:

> *"A target with no route needs neither, and opening 80 and 443 on a VPS that serves nothing is a
> hole for no reason."* — `firewall-requirements.ts`

In practice that is **Phase 8**, when the panel's own hostname is configured. It is a **one-time**
act: every later hostname reuses 80 and 443, so this never becomes a recurring dependency on
CloudForge and D-18 is not compromised.

### Who owns the rule?

**CloudForge** — the host firewall is CloudForge-owned in the ownership table, and a one-time
infrastructure action is precisely what CloudForge is for.

**But there is a gap on this box, and it is a CloudForge inconsistency worth naming:**

| CloudForge path | Opens 80/443? | Works here? |
|---|---|---|
| SSL & Domains → Let's Encrypt (`issue`) | **Yes** | ❌ hard-fails: `command -v docker \|\| exit 1` |
| SSL & Domains → Origin CA (`installOriginCertificate`) | **No** | ✅ works (openssl only) |
| VPS Runtime → Connectivity → Open required ports | Yes | Needs a plan with a TLS route and non-`legacy` mode |
| Ansible Nginx profile toggle | Port 80 only | ✅ already used |

So the Docker-free path that works does not open the port, and the path that opens the port needs
Docker. **RECOMMENDED (F6, a small CloudForge change): make the Origin CA install path open 80/443
through the same `openPortsFragment` the Certbot path already uses.** It is a few lines and removes
the gap permanently.

**Until F6 exists**, the clean route is: VPS Runtime → switch the target to `hybrid` → add the
panel's route to the plan → **Open required ports**. The rule is then created by CloudForge, carries
its marker, and exists for a recorded reason.

**Not recommended:** opening 443 by hand over SSH. The rule would carry no CloudForge marker, so
VPS Runtime would not recognise it and a later `openRequiredPorts` would be reasoning about a port it
did not open — on the one server where ownership can be correct from nothing.

### Who issues certificates?

**CloudOps, for every CloudOps hostname.** This is D-10 and the ownership model, and on this box it
is doubly true because CloudForge's Let's Encrypt path cannot run without Docker.

### Let's Encrypt or Cloudflare Origin CA?

Both are now available to CloudOps — `certbot 2.9.0` is in Ubuntu's repos, so no Docker is needed.

| | Origin CA | Let's Encrypt |
|---|---|---|
| Requires | Cloudflare-proxied record | Port 80 reachable, public DNS to this host |
| Validity | Up to 15 years | 90 days |
| Renewal burden | Effectively none | Every 60 days, must run server-side |
| Key handling | Generated on the server, never leaves | Same |
| Browser trust direct to origin IP | No | Yes |

**RECOMMENDED: Origin CA as the V1 default**, because every CloudOps hostname will be
Cloudflare-proxied and the renewal treadmill disappears. **Implement Let's Encrypt via native
`certbot` in Phase 8 as the documented fallback** for any DNS-only hostname.

Hard rule, from CloudForge's behaviour: it sets zones to **Full (strict)**. A proxied hostname
without a valid origin certificate returns **526**. So the certificate must exist *before* a hostname
goes live — certificate-before-live is a correctness requirement, not an optimisation.

### How CloudOps works when CloudForge is not running

Everything that matters: deployments, webhooks, worker restarts, cron, backups, health checks,
certificate renewal. The agent is a systemd service; the panel is a web application; neither knows
CloudForge exists.

CloudForge is needed only for **one-time infrastructure acts**: VPS lifecycle, the initial 80/443
rules, and (if F1) package installation. None is on a runtime path.

---

# D. The thirteen phases

Legend for "Changes": **VPS** = writes to the server · **CF** = changes CloudForge source · **Secret**
= needs a credential · **Approve** = needs your explicit go-ahead.

## PHASE 0 — Final decisions / prerequisites

| | |
|---|---|
| **Goal** | Close every decision that would otherwise be discovered mid-build |
| **Requires** | The architecture decision, startup plan and baseline (all exist) |
| **Actions** | Decide **D-19** and A.1–A.4; choose the panel hostname and zone; **D-26** access method; **D-27** panel database; **D-23** backup destination and key custody; approve the 443 policy (§C); approve F6 |
| **Owner** | **You** |
| **Changes** | VPS ✗ · CF ✗ · Secret ✗ · Approve — this phase *is* the approval |
| **Deliverable** | An updated decision table with no PENDING row blocking Phase 1 |
| **NOT yet** | No repository, no code, no package, no server change |

## PHASE 1 — VPS base/runtime preparation

| | |
|---|---|
| **Goal** | The host carries the runtimes CloudOps needs. Nothing CloudOps-specific exists yet |
| **Requires** | Phase 0 |
| **Actions** | Claude writes `scripts/bootstrap-host.sh` in the CloudOps repo: PHP 8.3 (cli, fpm, and the extensions Laravel needs), **distro `php8.3-fpm` service disabled** (D-05: CloudOps runs its own master), MySQL 8.0 bound to localhost with a generated root password, Composer via the official installer, Node 22 LTS, a swap file, optionally disable `rpcbind`. **You review it, then run it over SSH** |
| **Owner** | Claude (writes) · **You** (review and run) · CloudForge (nothing in V1; F1 later) |
| **Changes** | **VPS ✔** · CF ✗ · **Secret ✔** (MySQL root password, generated on the box, never leaves it) · **Approve ✔** |
| **Deliverable** | A host that passes the prerequisites contract. A `before`/`after` diff of installed packages and listening sockets |
| **NOT yet** | No `/srv/cloudops`, no agent, no Linux users, no pools, no databases, no 443 |

## PHASE 2 — CloudOps repository / bootstrap

| | |
|---|---|
| **Goal** | The repository exists, with CI, structure and documents — and no application code |
| **Requires** | Phase 0 |
| **Actions** | You create the **private** GitHub repository. Claude adds `panel/`, `agent/`, `contracts/`, `docs/`, `scripts/`; `.gitattributes` pinning LF; `.gitignore` covering `.env`, agent config, audit output, `vendor/`, `node_modules/`; CI running Go lint/test and PHP Pint/PHPStan/Pest; migrates the `E:\CloudOps` documents and `vps-audit.sh` in; adds these four `docs_cloudOps/` documents |
| **Owner** | **You** (create repo) · Claude (everything inside) |
| **Changes** | VPS ✗ · CF ✗ · Secret — a GitHub PAT only if CI needs one · **Approve ✔** (repo creation) |
| **Deliverable** | Green CI on a repository containing zero application code |
| **NOT yet** | No panel code, no agent code, no privileged operation |

## PHASE 3 — CloudOps architecture implementation

| | |
|---|---|
| **Goal** | The contracts and the operation catalogue, written **before** any privileged code exists |
| **Requires** | Phase 2 |
| **Actions** | Define the agent **operation catalogue** (typed, versioned, explicitly finite); the **deny list** (every CloudForge path, label and marker); the **manifest** and **prerequisites** JSON Schemas; the panel data model — `server`, `application`, `hostname`, `deployment`, `database`, `secret` — **carrying a server identity from the first migration** even though there is one server (D-22 condition 13) |
| **Owner** | Claude |
| **Changes** | VPS ✗ · CF ✗ · Secret ✗ · **Approve ✔** (review the catalogue — it is the security surface) |
| **Deliverable** | Schemas, catalogue and data model, with a passing test per deny-list entry |
| **NOT yet** | **No privileged operation implemented.** No code that writes to the server |

## PHASE 4 — Go agent

| | |
|---|---|
| **Goal** | A root daemon that does read-only work and refuses everything else |
| **Requires** | Phases 1 and 3 |
| **Actions** | Go module; **`GOOS=linux GOARCH=arm64`**; Unix socket; **peer-credential authorization**; audit log (root-only, rotated); prerequisites checker; manifest writer; deny-list enforcement; systemd unit with `MemoryMax`, `CPUQuota`, `TasksMax`. **Zero privileged operations in this phase** |
| **Owner** | Claude (code) · **You** (install the binary and unit) |
| **Changes** | **VPS ✔** · CF ✗ · Secret — agent config file created, initially empty · **Approve ✔** |
| **Deliverable** | `cloudops-agent` active, answering a read-only `prerequisites` call, writing a secrets-free manifest, refusing an unauthorized caller and every denied path — each refusal audited |
| **NOT yet** | No user creation, no pool, no site, no database, no deployment |

## PHASE 5 — Secure Panel ↔ Agent communication

| | |
|---|---|
| **Goal** | An authenticated, authorized, audited channel — proven in both directions |
| **Requires** | Phase 4 |
| **Actions** | Create the unprivileged `cloudops` Linux user (no sudo, no shell, **not in any root-equivalent group**); socket `root:cloudops 0660`; protocol versioning; a PHP client library; **negative tests**: an unauthorized user is refused and the refusal is audited |
| **Owner** | Claude (code) · **You** (create the user, or the agent installer does) |
| **Changes** | **VPS ✔** · CF ✗ · Secret ✗ · **Approve ✔** |
| **Deliverable** | The panel user calls the agent successfully; another user cannot; both outcomes appear in the audit log |
| **NOT yet** | No panel UI, no application concept |

## PHASE 6 — Application provisioning

| | |
|---|---|
| **Goal** | The first **privileged** operations, each individually allowlisted |
| **Requires** | Phase 5 |
| **Actions** | Implement and test: create application Linux user and group; create the `/srv/cloudops/apps/<slug>/` layout; create a PHP-FPM pool on the CloudOps-owned master; write an Nginx site under `/etc/cloudops/nginx/sites/`; install the single `zz-cloudops.conf` include; `nginx -t`; graceful reload; **hostname conflict detection scanning every `server_name` on the host, CloudForge's included** |
| **Owner** | CloudOps (agent) · Claude (code) · **You** (approve the include file) |
| **Changes** | **VPS ✔** · CF — **one file inside `/etc/nginx/conf.d/`, with your approval** · Secret ✗ · **Approve ✔** |
| **Deliverable** | A static page served over **HTTP** from a CloudOps-owned site and pool |
| **NOT yet** | No Git, no Composer, no release, no TLS, no database |

## PHASE 7 — PHP/Laravel deployment

| | |
|---|---|
| **Goal** | Release-based deployment with a proven automatic rollback |
| **Requires** | Phase 6 |
| **Actions** | `releases/`, `shared/{.env,storage}`, atomic `current` switch by rename; Git checkout with a per-app deploy key; Composer and npm **as the application user**; `storage:link`; `optimize`; **pre-switch** health check against the new release, **post-switch** health check through Nginx; automatic revert; retention of N releases; per-application deployment lock. **`key:generate` at creation only; `migrate --force` only when explicitly enabled; never `migrate:fresh`/`reset`/`db:wipe`** |
| **Owner** | CloudOps · Claude |
| **Changes** | **VPS ✔** · CF ✗ · **Secret ✔** (deploy keys, `.env`) · **Approve ✔** |
| **Deliverable** | A throwaway Laravel application deployed, then **deliberately broken to prove the rollback fires** |
| **NOT yet** | No real application, no TLS, no workers |

## PHASE 8 — Domains / Nginx / SSL

| | |
|---|---|
| **Goal** | A CloudOps hostname served over HTTPS |
| **Requires** | Phase 7; a DNS record; a Cloudflare token |
| **Actions** | **443 opened once, by CloudForge** (§C). Cloudflare Origin CA issuance implemented in the agent (key and CSR on the server, only the CSR leaves); certificate installed under `/etc/cloudops/certs/`; the site switched to TLS with redirect; **native `certbot`** implemented as the documented DNS-only fallback; agent verifies the include file on every operation |
| **Owner** | **CloudForge** (the 443 rule) · **CloudOps** (certificates) · **You** (DNS, token) |
| **Changes** | **VPS ✔** · **CF ✔** — the firewall rule, and F6 if you approve it · **Secret ✔** (narrow Cloudflare token, agent config only) · **Approve ✔** |
| **Deliverable** | `https://<panel-hostname>` served by a CloudOps-owned site with a valid origin certificate, zone on Full (strict) |
| **NOT yet** | No public panel login — Phase 13 hardens access first |

## PHASE 9 — Database management

| | |
|---|---|
| **Goal** | Per-application databases, created and owned by CloudOps |
| **Requires** | Phase 1 (MySQL), Phase 6 |
| **Actions** | Create a restricted admin account scoped to the CloudOps namespace — **never `root`**; agent operations to create a database and user, rotate a password, and drop (destructive, exact-name confirmation); wire credentials into `shared/.env`; a single-database backup and **restore** |
| **Owner** | CloudOps |
| **Changes** | **VPS ✔** · CF ✗ · **Secret ✔** · **Approve ✔** |
| **Deliverable** | An application with its own database, and a restore proven into a scratch database |
| **NOT yet** | No scheduled backups — Phase 11 |

## PHASE 10 — Queue / Cron / Workers

| | |
|---|---|
| **Goal** | Long-running application processes, isolated and restartable |
| **Requires** | Phase 7 |
| **Actions** | systemd unit per application worker, running as the application user, with resource limits; **graceful restart after the `current` switch** (`SIGTERM`, finish the job, restart from the new release); scheduler entry per application in a CloudOps-owned cron location |
| **Owner** | CloudOps |
| **Changes** | **VPS ✔** · CF ✗ · Secret ✗ · **Approve ✔** |
| **Deliverable** | A queued job processed; a worker picking up new code after a deploy without dropping a job |
| **NOT yet** | No Horizon, no Reverb |

## PHASE 11 — Logs / Monitoring / Backups

| | |
|---|---|
| **Goal** | You can see what happened, and you can get the data back |
| **Requires** | Phases 7 and 9 |
| **Actions** | Per-application Nginx and PHP-FPM logs with **rotation configured from the start**; deployment logs, masked; agent audit log rotation; scheduled database and `shared/` backups, **encrypted before leaving the server**, to an off-server destination; a **restore drill**; disk floor check that refuses a deployment below a threshold |
| **Owner** | CloudOps · **You** (backup destination and key custody — D-23) |
| **Changes** | **VPS ✔** · CF ✗ · **Secret ✔** (backup destination credentials, encryption key) · **Approve ✔** |
| **Deliverable** | A backup taken, shipped off-server, and **restored** |
| **NOT yet** | No alerting — later |

## PHASE 12 — First real Laravel application

| | |
|---|---|
| **Goal** | A real application you depend on, hosted by CloudOps |
| **Requires** | Phases 7–11 complete, **with the restore proven** |
| **Actions** | Create the application; connect the repository; configure the database and environment; deploy; attach the hostname; issue the certificate; enable workers and cron; verify; **take a backup immediately** |
| **Owner** | **You** (choose the application) · CloudOps |
| **Changes** | **VPS ✔** · CF ✗ · **Secret ✔** · **Approve ✔** |
| **Deliverable** | A production application on CloudOps. **This is the moment the server stops being disposable** |
| **NOT yet** | No migration of HanoutPlus or any existing Docker/Jenkins application — out of scope (D-24) |

## PHASE 13 — Security hardening and production readiness

| | |
|---|---|
| **Goal** | The platform is defensible, not merely working |
| **Requires** | Phase 12 — though several items should land far earlier, marked below |
| **Actions** | **Mandatory TOTP 2FA and rate-limited login (do this in Phase 8, before the panel is reachable)**; Cloudflare Access in front of the panel (D-26); webhook signature verification, replay rejection, rate limits; **canary-secret test in CI (add in Phase 2, not here)**; `open_basedir` per pool; resource limits on every CloudOps unit; documented and tested **uninstall** procedure; periodic conflict scan of hostnames, ports and Nginx files; a restore drill on a schedule |
| **Owner** | CloudOps · **You** (Access policy) |
| **Changes** | **VPS ✔** · CF ✗ · **Secret ✔** · **Approve ✔** |
| **Deliverable** | A hardening checklist with every item evidenced |
| **NOT yet** | Multi-server, mTLS, team accounts |

---

# E. The first milestone

### Your proposed example, evaluated

> *"CloudOps panel is running securely, CloudOps agent is installed, authenticated communication
> works, and the panel can perform one harmless allowlisted operation on the VPS."*

**Good, but it is the wrong first one — it bundles four achievements**, and "one harmless allowlisted
operation" proves the plumbing rather than the boundary. If the panel, the agent, authentication and
an operation all land together and something misbehaves, you cannot tell which half is wrong.

It is an excellent **second** milestone.

### RECOMMENDED first milestone

> **M1 — The boundary holds.**
>
> The `cloudops-agent` runs as root on the VPS, exposes a Unix socket authorized by peer
> credentials, answers a **read-only** prerequisites call from an unprivileged local client, writes a
> secrets-free manifest to `/var/lib/cloudops/manifest.json`, and **refuses both an unauthorized
> caller and every path on the CloudForge deny list — with every refusal recorded in the audit log.**
>
> No panel. No PHP application. No privileged operation. Nothing CloudForge owns is touched.

Why this one:

- It tests the **riskiest architectural claim** — that a root daemon can be safely reachable from an
  unprivileged, internet-adjacent process. If that is wrong, everything above it is worthless, and
  you want to know in week one.
- It is **genuinely falsifiable**: run as the wrong user, it must refuse; ask for a CloudForge path,
  it must refuse; read the audit log and both refusals are there.
- It needs **no PHP, no MySQL, no Node, no certificate, no port 443** — so it is reachable almost
  immediately after Phase 1.
- It leaves the server **trivially recoverable**: one systemd unit and one binary to remove.

**M2** is then your example: the panel runs behind its access control, talks to the agent, and
performs one allowlisted privileged operation — Phases 5 and 6.

**M3** is the first Laravel application deployed with a proven rollback — Phase 7.

### One simplification the clean VPS buys you

The startup plan assumed every destructive test needed a separate disposable VM, because `abdohero`
carried production traffic. **This server is itself disposable right now** — nothing on it, no
traffic, destroyable and rebuildable from the CloudForge stack in 38 seconds.

So Phases 1–11 can be developed directly on it. **The moment it stops being disposable is Phase 12**,
when the first real application lands — and from that point a separate VM is needed again for
destructive testing.

---

# F. Who does what

## A. What you need to do

1. **Decide D-19 and A.1–A.4** (§A) — the gate for everything.
2. **Decide**: panel hostname and zone · D-26 access method · D-27 panel database · D-23 backup
   destination and key custody · whether you accept **F6** (the Origin CA firewall fix).
3. **Create** the private `CloudOps` GitHub repository.
4. **Review and run** the Phase 1 bootstrap script over SSH.
5. **Create** the Cloudflare DNS record and a **new narrow token** for CloudOps.
6. **Approve** each phase that writes to the VPS.
7. **Choose** the first real application for Phase 12.

## B. What CloudForge needs to do

Only three things, all one-time:

1. **Open 443**, once, at Phase 8 (§C).
2. **F6** *(optional, recommended)* — make the Origin CA path open 80/443 as the Certbot path does.
3. **F1** *(later)* — promote the proven bootstrap script to an Ansible profile.

Everything else CloudForge already did: the VPS, the network, the OCI firewall, Nginx, port 80.
**CloudForge needs no change for Phases 0–7.**

## C. What Claude/development needs to do

Phase 1 bootstrap script · the repository skeleton and CI · contracts, catalogue and deny list ·
the Go agent · the Laravel panel · the deployment pipeline · certificates, databases, workers, cron,
logs, backups · tests at every phase, including the negative ones.

## D. What we must decide

| ⬜ | Decision | Recommendation |
|---|---|---|
| ⬜ | **D-19** | Hybrid, phased: bootstrap script now, F1 later, **agent never installs** |
| ⬜ | PHP versions | **One: Ubuntu's 8.3.6.** Design for many |
| ⬜ | Database engine | **MySQL 8.0.46** — weakly held; MariaDB equally defensible |
| ⬜ | Node | **NodeSource 22 LTS, global**; verify arm64 on the box |
| ⬜ | Composer | **Global binary, run as the app user**, per-app `COMPOSER_HOME` |
| ⬜ | **D-26** panel access | **Cloudflare Access** |
| ⬜ | **D-27** panel database | MySQL on the same server |
| ⬜ | **D-23** backups | Off-server, V1, with a proven restore. **Destination and key custody are yours** |
| ⬜ | Panel hostname and zone | — |
| ⬜ | 443 policy | Opened once by CloudForge at Phase 8 |
| ⬜ | **F6** | Recommended |
| ⬜ | First milestone | **M1 as defined in §E**, not the bundled example |

## E. What we absolutely should NOT install yet

| Never on this server | Why |
|---|---|
| **Docker** | No root-equivalent group, no DNAT bypassing the host firewall. The property that makes this box safer than the other one |
| **Jenkins** | Belongs with the container applications |
| **Dockhand / Portainer** | Container management UIs — one is publicly exposed on the other server today |
| **PostgreSQL** | CloudOps uses MySQL/MariaDB |

| Not yet (right thing, wrong time) | When |
|---|---|
| PHP, MySQL, Node, Composer | Phase 1, **after D-19** |
| The agent | Phase 4 |
| The panel | Phase 5–6 |
| Port 443 | Phase 8, by CloudForge |
| Any certificate | Phase 8 |
| Any Linux user or PHP-FPM pool | Phase 6 |
| Any real application | Phase 12, after a proven restore |

---

## Status

**Nothing has been implemented, installed or modified.** No VPS change, no CloudForge change, no
application code, no agent, port 443 still closed.

**The next action is yours: §D.** D-19 is the gate — Phase 1 cannot start without it.
