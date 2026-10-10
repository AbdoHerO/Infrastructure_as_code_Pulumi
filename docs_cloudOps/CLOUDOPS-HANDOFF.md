# CloudOps — Architecture and Requirements Handoff

| | |
|---|---|
| **Purpose** | Hand over everything learned about CloudOps to the Claude session working on `infrastructure_as_code` (CloudForge), so that it can make and justify the repository/module architecture decision |
| **Status** | Handoff for architecture review. **Not implementation documentation.** |
| **Date** | 2026-10-07 |
| **From** | The CloudOps specification session (workspace `E:\CloudOps`) |
| **To** | The Claude session working on `C:\Users\abder\Documents\___Abdou_GIT\infrastructure_as_code\infrastructure_as_code` |
| **CloudForge reviewed** | v0.4.1, branch `main`, reviewed at commit `a5034a1` (2026-09-10). A later commit `b53e8ad` (2026-10-07) and uncommitted work touch project management only and do not change the findings below. |
| **Repository/module architecture** | **NOT DECIDED** (section 18) |
| **CloudOps code** | **NOT BUILT** (section 23) |

### How to read this document

- **ACCEPTED** means the owner explicitly asked for it or approved it.
- **PROPOSED** means it is a recommendation from the investigation that the owner has not yet
  approved. Do not treat it as final.
- **PENDING** means it cannot be decided until something else happens (the VPS audit, or an owner
  decision).
- **REJECTED** means the owner explicitly ruled it out.
- Facts about CloudForge come from reading its documentation and source code. Where a statement
  is an inference rather than something read directly, it says so. File references are listed in
  Appendix A so that they can be verified.
- This document does not authorize any implementation, any change to CloudForge, or any change
  to a server.

---

## 1. Executive Summary

**What CloudOps is meant to be.** CloudOps is a self-hosted hosting control plane: one place to
create, deploy and operate many PHP and Laravel applications on the owner's own VPS, with the
day-to-day experience of a shared-hosting panel (Hostinger hPanel, cPanel, CloudPanel), but built
for the owner's own infrastructure and applications.

**Why the owner wants it.** The owner runs several PHP/Laravel applications and plans many more.
Today each application is deployed as its own small infrastructure project: a Dockerfile, a
Docker Compose file, a Jenkinsfile, a Jenkins job, an Nginx site, a certificate, a database, an
environment file, queue workers, a scheduler and so on. CloudForge (the owner's existing
infrastructure tool) already automates parts of this, but the per-application work is still
repeated for every new project, and every application carries its own copy of the stack.

**The current deployment workflow.** With CloudForge, an application typically goes through:
a repository with its own Dockerfile and Compose file → a Jenkins pipeline created by CloudForge
on the VPS → Jenkins builds and starts the containers on a dedicated host port (`HOST_PORT`) →
CloudForge creates a Cloudflare DNS record and an Nginx reverse-proxy site to `127.0.0.1:<port>` →
CloudForge issues a certificate (Let's Encrypt or Cloudflare Origin CA). A Laravel application such
as HanoutPlus runs Apache, its queue workers, Reverb and the scheduler under Supervisor inside its
own container, with its own MySQL and Redis containers.

**Why this becomes difficult.** Each application multiplies the same decisions and files, its own
database server and runtime, its own port, its own pipeline and its own failure modes. Knowledge
is spread across many Jenkinsfiles and Compose files that drift apart. A small VPS spends its
memory on duplicated runtimes. There is no single place that shows every application, its domain,
its health, its last deployment and its backups.

**Why a hosting-panel experience.** Shared-hosting panels solve exactly this: many applications on
one server, each created from a form, with domains, PHP versions, databases, SSL, files, cron, logs
and backups handled by the panel rather than by per-project scripts. The owner wants that
experience on infrastructure they control.

**Relationship with CloudForge.** CloudForge stays the infrastructure layer (servers, networks,
firewalls, packages, Docker, Jenkins, container applications, Cloudflare zones). CloudOps would be
the hosting layer on top of it, for native PHP/Laravel applications. Each server resource has
exactly one owner. CloudOps must not rebuild what CloudForge already does, and must not depend on
CloudForge at runtime, because CloudForge is a desktop application without an API.

**What is not decided.** Whether CloudOps becomes a separate repository/application or a module or
application inside `infrastructure_as_code` is **not decided**. That decision is the main task for
the receiving session (sections 18, 19 and 24).

> **Key objective:** Build a self-hosted hosting/application control plane that allows me to
> deploy and manage many PHP and Laravel applications on infrastructure already provisioned and
> managed by CloudForge, without creating a separate Jenkins/Docker/infrastructure deployment
> stack for every application.

---

## 2. Original Problem

When the owner creates a new application today, they typically have to deal with each of the
following, separately, for that application:

| Concern | What it involves today |
|---|---|
| Dockerfile | Choosing a base image, PHP version and extensions, web server, Supervisor configuration, build steps |
| Docker Compose | Application, database, Redis, network, volumes, healthchecks, port mapping |
| Jenkinsfile | Checkout, build, test, migrations, deploy, cleanup; reading `HOST_PORT` and the environment credential |
| Jenkins job | Created and kept in sync by CloudForge; credentials pushed into Jenkins |
| Nginx configuration | A reverse-proxy site per hostname, additional routes (for example Reverb on `/app`) |
| SSL | Let's Encrypt or Origin CA per hostname; renewal tied to the CloudForge desktop app being open |
| Database | Usually a MySQL container per application, private to its Compose network |
| Environment variables | A `.env.production` stored as a CloudForge credential and pushed into Jenkins |
| PHP version | Baked into each image |
| Deployment scripts | Whatever each repository's Jenkinsfile does |
| Queues | Supervisor programs inside the container |
| Cron / scheduler | `schedule:work` inside the container |
| Logs | Spread across container logs, Nginx logs and Jenkins console output |
| Backups | Not handled for application data or databases |
| Domain configuration | Cloudflare record, Nginx site, certificate, firewall ports |

Why this does not scale operationally:

- **Repetition.** The same 15 concerns are re-solved for every application, by copying files from a
  previous project and adjusting them.
- **Drift.** Copies diverge: different base images, PHP versions, Supervisor settings and deploy
  steps. Fixing a problem once does not fix it everywhere.
- **Resource cost.** Each application carries its own web server, its own PHP runtime, its own
  MySQL and Redis. On a small VPS (the CloudForge-built server has 1 OCPU and 6 GB RAM) this limits
  how many applications fit.
- **Port management.** Every application needs a unique host port, kept consistent between Jenkins
  and Nginx.
- **Patching.** Security updates must be applied per image and redeployed per application.
- **No single view.** There is no place to see all applications with their domain, status, last
  deployment, certificate and backups.
- **Backups are missing.** Nothing currently backs up application data or databases.
- **Onboarding cost.** Adding a small PHP site costs almost as much effort as adding a large one.

---

## 3. Desired User Experience

The workflow the owner wants:

```text
Create Application
   → Choose PHP or Laravel
   → Choose domain
   → Select PHP version
   → Connect Git repository
   → Create database
   → Configure environment variables
   → Enable SSL
   → Deploy
```

After that, a push to the configured branch redeploys automatically. CloudOps handles the
application-level infrastructure without per-project Dockerfiles, Jenkinsfiles or hand-written
Nginx configuration:

- the application's Linux user, directories and permissions;
- its PHP-FPM pool on the chosen PHP version;
- its Nginx site and certificate;
- its database and database user;
- its `.env`, generated once and editable later;
- release-based deployments with health checks and automatic revert;
- the Laravel scheduler and queue workers;
- logs, backups and basic monitoring.

Expected panel views (indicative, not a design): an application list (name, type, domains, PHP
version, status, last deployment); an application page with tabs for overview, deployments,
domains and SSL, database, environment, files, workers and cron, logs, backups and settings; a
server page showing resources and prerequisite status.

Conceptual references: Hostinger hPanel, cPanel, CloudPanel (and, for the deployment model,
products such as Laravel Forge). These are references for the experience only. Their
implementations must not be copied, and CloudOps is optimized for the owner's own infrastructure
and PHP/Laravel applications rather than for general-purpose hosting.

---

## 4. CloudOps Purpose

### CloudOps is

- **An application hosting control plane**: it owns the lifecycle of the applications it hosts.
- **A PHP/Laravel hosting management platform**: native PHP-FPM applications, with Laravel as a
  first-class type.
- **A deployment orchestration system**: Git-based, release-based deployments with health checks,
  automatic revert and deployment history.
- **A domain/application management layer**: hostnames attached to applications, with certificates.
- **A database/application environment manager**: per-application databases, users and `.env`.
- **A self-hosted alternative** to managing every application independently.

### CloudOps is NOT (initially)

- **A cloud provider.**
- **A VPS provisioning platform**: servers are provisioned by CloudForge.
- **A replacement for CloudForge**: it builds on it.
- **A Docker management platform**: Docker belongs to CloudForge, and CloudOps applications do not
  require Docker.
- **A Jenkins replacement for container applications**: those stay on CloudForge/Jenkins.
- **A general-purpose server administration panel**: no firewall editor, package manager, user
  administration or SSH management.

---

## 5. CloudForge Context

### Identity

| | |
|---|---|
| Name | CloudForge (`cloudforge`, packages `@cloudforge/*`) |
| Version | `v0.4.1` |
| Branch | `main` |
| Repository | `infrastructure_as_code` (GitHub remote `Infrastructure_as_code_Pulumi`) |
| Location | `C:\Users\abder\Documents\___Abdou_GIT\infrastructure_as_code\infrastructure_as_code` |

### Architecture

- **Windows Electron desktop application** (Electron 43, React 18, electron-vite), single user.
- **TypeScript monorepo**: pnpm workspaces (`apps/*`, `packages/*`) and Turborepo. One app
  (`apps/desktop`) and eight packages: `shared`, `ui`, `core` (domain and application layers, ports),
  `database` (Prisma/SQLite), `providers` (Oracle, AWS), `pulumi`, `service-providers`
  (Cloudflare), `deployment` (all SSH adapters). Internal packages are consumed as TypeScript source.
- Clean/hexagonal architecture: services return `Result<T, AppError>`; the renderer talks to the main
  process only through a typed IPC contract (about 170 channels).
- **Local SQLite** database under the user profile (`cloudforge.db`), not encrypted as a whole.
- **Windows keychain for secrets**: credentials are encrypted with Electron `safeStorage` (DPAPI on
  Windows), with an AES-256-GCM key-file fallback.
- **Password-protected projects**: each project is an isolated workspace unlocked with a passkey
  (scrypt hash). The passkey is an access gate, not an encryption key.

### Infrastructure mechanisms

- **Pulumi** Automation API with a local file backend (no Pulumi Cloud).
- **Oracle Cloud** (VCN, subnet, security list, instance, block volume) and **AWS** (VPC, security
  group, EC2, EBS). No DNS or load balancers through Pulumi.
- **Existing servers via SSH**: any reachable server can be saved as a VPS target (host, user, SSH
  key or password, pinned host-key fingerprint). Pulumi cannot import existing cloud servers.
- **Ansible**: built-in playbooks (TypeScript strings) run *on the server* in a virtualenv at
  `/opt/cloudforge/ansible`. Profiles: Docker, Dockhand, Portainer, Jenkins, Nginx, PostgreSQL.
- **SSH** (`ssh2` library): every server operation is a shell command or file upload over SSH, as
  root or with passwordless sudo.
- Supported server OS (preflight): Ubuntu, Debian, RHEL, CentOS, Rocky, AlmaLinux, Oracle Linux, on
  x86_64 or aarch64.

### Current infrastructure capabilities

| Capability | How | Footprint on the server |
|---|---|---|
| Servers | Pulumi create/update/replace/destroy; start, stop, terminate | — |
| Networks | Pulumi VCN/VPC, subnets, gateways, routes | — |
| Firewalls | Cloud security lists (Oracle, live edit); host firewall opening through ufw, firewalld, nftables or iptables (additive only) | nft table `inet cloudforge`; comment `CloudForge managed service`; `/etc/nftables.conf` rewritten on nftables hosts |
| Docker | Docker CE profile; container start/stop/remove/logs/stats | Docker service, `docker.service.d/cloudforge-firewalld.conf` on RHEL |
| Docker Compose | Writes and starts user-supplied Compose files | `/opt/cloudforge/compose/<project>/` |
| Docker networks | Runtime apply creates, connects, disconnects, removes networks | Labels `io.cloudforge.*`; PostgreSQL profile uses `com.cloudforge.*` |
| Jenkins | Installs Jenkins natively; folder per server, job per application, over the Jenkins HTTP API | Jenkins service, `jenkins.service.d/cloudforge.conf`, folders `cloudforge-<target>-<id>` |
| Nginx | Native (Ansible profile) or containerised; reverse-proxy sites, `nginx.conf` editor, validate, reload, backup, restore | `/etc/nginx/conf.d/cloudforge-<domain>.conf`, `/var/lib/cloudforge/nginx/backups/*.tar.gz` |
| Certificates | Let's Encrypt via a throwaway Certbot container (HTTP-01 webroot); Cloudflare Origin CA (key generated on the server) | `/opt/cloudforge/certs/live/<domain>/`, `/opt/cloudforge/www` (UI defaults) |
| Cloudflare | Zones, DNS, zone SSL/TLS settings, cache purge (whole zone), page and redirect rules, analytics; read-only WAF, Workers, R2, Access inventories | DNS records commented `Managed by CloudForge` |
| DNS | Records created or updated by Jenkins domain automation and by the DNS editor; refuses to repoint records it did not create | — |
| Runtime/drift model | `VpsRuntimePlan` per server: applications, services, networks, routes, certificates, owned DNS records; drift and connectivity checks; modes `legacy` (read-only, default), `hybrid`, `managed`; preview → apply with single-use tokens | Only Docker network operations are ever applied |
| PostgreSQL | One `postgres:17-alpine` container per profile run | `/opt/cloudforge/apps/postgres/<name>/` |

### What CloudForge does not do

No PHP or PHP-FPM, no MySQL/MariaDB, no native Git checkout or builds on the server, no
release/rollback, no Linux users per application, no cron or timers on the server, no application
or database backups, no file manager, no multi-user or web access.

### Facts that shape CloudOps

- **CloudForge has no server-side API.** There is no HTTP server, CLI, socket or protocol handler.
  Everything is internal Electron IPC.
- **CloudForge has no permanent agent on the server.** Every operation is a short SSH session.
- **CloudForge's scheduled operations depend on the desktop application being open** with the
  project unlocked: Let's Encrypt renewal and Cloudflare synchronization are timers in the Electron
  main process.
- **Therefore CloudOps must NOT depend on CloudForge being running.** A webhook-triggered deployment
  at night, a certificate renewal, a queue worker restart or a backup must all work with the
  CloudForge desktop app closed.
- **CloudForge already follows "a resource I did not create is not mine".** It never edits Nginx
  sites without its marker, never repoints DNS records without its marker, never treats unlabelled
  Docker resources as drift. CloudOps can rely on and mirror this rule.

---

## 6. CloudForge Responsibilities

Proposed ownership model (decision D-16, **PROPOSED**). CloudForge owns:

| Resource | Why it stays with CloudForge |
|---|---|
| VPS provisioning (create, resize, replace, destroy) | Pulumi state and cloud credentials live in CloudForge |
| Infrastructure and cloud networking (VCN/VPC, subnets, gateways) | Same |
| Server firewalls: cloud security lists and the host firewall | CloudForge already reasons about both together (Runtime connectivity) |
| OS and infrastructure configuration (packages, services, Ansible profiles) | One tool of record for packages avoids two package managers fighting |
| Docker, Docker Compose, Docker networks | Runtime model, labels and Compose directories are CloudForge's |
| Jenkins | Installed and driven by CloudForge |
| Container applications (for example HanoutPlus) and their reverse-proxy routes | Deployed by Jenkins pipelines that CloudForge manages |
| CloudForge-owned Nginx configuration: the Nginx installation, `nginx.conf`, `conf.d/cloudforge-*.conf` | CloudForge's Nginx manager, backups and restores operate on `/etc/nginx` |
| CloudForge-owned certificates (`/opt/cloudforge/certs`, Certbot webroot) | Issued and renewed by CloudForge for its own sites |
| Cloudflare infrastructure and zone configuration (SSL mode, HSTS, cache, page and redirect rules, purges) | Zone-wide settings affect every hostname; one owner only |
| CloudForge-owned DNS records (comment `Managed by CloudForge`) | CloudForge's ownership marker |

These remain under CloudForge's ownership whatever repository architecture is chosen. CloudOps may
read some of them (for conflict detection and status) but never writes them.

---

## 7. CloudOps Responsibilities

Proposed ownership model (D-16, **PROPOSED**). CloudOps owns:

| Area | CloudOps-owned resources |
|---|---|
| Applications | Native PHP applications and Laravel applications created in (or explicitly imported into) CloudOps |
| Isolation | One Linux user and group per application (proposed prefix `co-<slug>`) |
| Files | The application directories (base path pending, section 14) |
| Runtime | PHP-FPM configuration and services for CloudOps applications (proposed: CloudOps-owned PHP-FPM master per PHP version, D-05) |
| Web | CloudOps-owned Nginx sites, outside `/etc/nginx` (D-17, section 9) |
| Domains | Hostnames attached to CloudOps applications (each hostname owned by exactly one product) |
| Certificates | Certificates for CloudOps hostnames, in CloudOps-owned paths |
| Databases | MySQL/MariaDB databases and users used by CloudOps applications (proposed prefix `co_`) |
| Deployments | Git deployments, Composer, npm builds, environment variables, release management, the `current` symlink, rollback, deployment logs |
| Processes | Queue workers and other long-running Laravel processes; cron jobs (as the application user) |
| Operations | Application logs, database backups, application backups (including off-server copies), application-level monitoring |

### Infrastructure ownership versus application-hosting ownership

| Question | Infrastructure (CloudForge) | Application hosting (CloudOps) |
|---|---|---|
| Does the server exist, and how big is it? | ✔ | |
| Is port 443 open? | ✔ | reports if not |
| Is PHP 8.3 installed with the right extensions? | ✔ (D-19 pending) | checks, never installs |
| Is MySQL installed and running? | ✔ (D-19 pending) | uses it through a limited account |
| Is Nginx installed, and what does `nginx.conf` contain? | ✔ | owns one include file only |
| Which PHP-FPM pool serves `shop.example.com`? | | ✔ |
| Which release of the shop is live? | | ✔ |
| Which database does the shop use? | | ✔ |
| Is the shop's certificate valid? | | ✔ |
| Is the zone in Full (strict) mode? | ✔ | reads it |

---

## 8. Ownership Principle

**Every resource must have exactly one owner.**

| Resource | Owner |
|---|---|
| HanoutPlus (Docker/Jenkins application) and its Nginx site, certificate, DNS record, containers | CloudForge |
| A native Laravel application created in CloudOps, its user, pool, site, certificate, database | CloudOps |
| `nginx.conf` and `/etc/nginx/**` | CloudForge |
| `/etc/nginx/conf.d/zz-cloudops.conf` (the one include file) | CloudOps |
| `/etc/cloudops/**`, CloudOps application directories, `cloudops-*` systemd units | CloudOps |
| `/opt/cloudforge/**`, `/var/lib/cloudforge/**` | CloudForge |
| Host firewall rules, cloud security lists | CloudForge |
| Cloudflare zone settings | CloudForge |
| A DNS record | Whoever marked it (`Managed by CloudForge` / `Managed by CloudOps`); unmarked records belong to the owner, and neither product changes them |
| The MySQL/MariaDB server itself | Infrastructure layer (D-19 pending) |
| `co_*` databases and users | CloudOps |
| A hostname | Exactly one product, never both |

Rules:

- **CloudForge must never modify CloudOps-owned resources.** CloudForge already never edits what it
  did not create; the remaining risk is whole-directory operations (section 9).
- **CloudOps must never modify CloudForge-owned resources.** CloudOps reads them only for conflict
  detection and status.
- Ownership is recognized from names, paths, labels and markers, not from memory: both products can
  rebuild their view from the server.

Why this is required:

- **Conflicts.** Two products writing server blocks for the same hostname produce Nginx "conflicting
  server name" behaviour, where only one is served and which one depends on load order.
- **Destructive restores.** CloudForge's Nginx rollback replaces the whole `/etc/nginx` tree; any
  foreign file inside it can disappear silently (section 9).
- **Duplicated configuration.** Two certificate renewers, two DNS writers or two firewall writers
  for the same thing will overwrite each other.
- **Unpredictable behaviour.** If both products believe they own a resource, each "repairs" the
  other's changes as drift.
- **Safe adoption and migration.** A resource can only be handed from one product to the other
  deliberately, as an explicit owner action, when ownership is unambiguous.

---

## 9. Nginx Architecture

### The conflict discovered

- CloudForge manages `/etc/nginx`. Its Nginx manager writes `conf.d/cloudforge-<domain>.conf`, can
  overwrite `nginx.conf` from its advanced editor, and reloads Nginx after validation.
- **Every CloudForge Nginx change is a transaction over the whole directory:** it first archives
  all of `/etc/nginx` to `/var/lib/cloudforge/nginx/backups/<timestamp>.tar.gz`. If `nginx -t` fails,
  it **empties `/etc/nginx` in place** (`find /etc/nginx -mindepth 1 -delete`) and extracts the
  archive. The owner can also restore any archive manually.
- Consequence: any CloudOps file inside `/etc/nginx` that was created after the archive was taken
  would be deleted by a rollback or restore, without any error on the CloudOps side.

### Proposed architecture (D-17, PROPOSED)

```text
/etc/nginx/                                   owned by CloudForge
├── nginx.conf                                 (already contains: include /etc/nginx/conf.d/*.conf;)
└── conf.d/
    ├── cloudforge-hanoutplus.ma.conf          CloudForge site
    ├── cloudforge-api.hanoutplus.ma.conf      CloudForge site
    └── zz-cloudops.conf                       CloudOps' ONLY file in /etc/nginx:
                                                 include /etc/cloudops/nginx/sites/*.conf;

/etc/cloudops/nginx/                           owned by CloudOps (outside CloudForge's archives)
├── sites/
│   ├── shop.conf                              one file per CloudOps application
│   └── crm.conf
└── snippets/
    ├── cloudflare-real-ip.conf                visitor IP restoration for proxied hostnames
    ├── php-fastcgi.conf                       shared PHP-FPM settings
    └── security-headers.conf
```

- CloudOps does **not** edit `nginx.conf`. It relies on the standard `include conf.d/*.conf` that both
  Debian and RHEL packages ship, and installs a single include file once, with the owner's approval.
- CloudOps sites, snippets and certificates live in `/etc/cloudops`, which CloudForge's archives and
  restores never touch.
- CloudOps writes its files atomically (temporary file, then rename), runs `nginx -t` before every
  reload, and removes its own change if validation fails. Reloads are graceful.
- Native host Nginx is required: CloudOps sites talk to PHP-FPM over Unix sockets, which a
  containerised Nginx cannot reach.

### Remaining risks and mitigations

| Risk | Mitigation |
|---|---|
| Restoring a CloudForge archive older than the CloudOps installation removes `zz-cloudops.conf`; all CloudOps sites stop being served | The CloudOps agent checks the include on every operation and every health check, alerts, and can restore its own file with owner confirmation |
| An `nginx.conf` edit in CloudForge removes `include conf.d/*.conf` | Same detection; the fix is made in CloudForge |
| Both products change Nginx at the same moment; one side's `nginx -t` fails | Atomic writes and validation keep the window small; a shared lock (`flock /run/lock/nginx-config.lock`) used by both would remove it (CloudForge change F3) |
| The same hostname is configured in both products | CloudOps scans every `server_name` and refuses a hostname served elsewhere; periodic scans report later conflicts |
| Nginx runs in a container | Edge decision D-14 (PENDING audit); any change is done through CloudForge |

---

## 10. Cloudflare Architecture

- **CloudForge already manages Cloudflare**: zones, DNS records, zone SSL/TLS settings, cache, page
  and redirect rules, Origin CA certificates. After issuing an Origin CA certificate it sets the zone
  to **Full (strict)** and **Always Use HTTPS**.
- **CloudOps uses a separate, narrowly scoped API token** (D-21, PROPOSED): Zone Read, DNS Read,
  SSL and Certificates Edit, restricted to the zones of CloudOps hostnames. DNS Edit is added only if
  CloudOps later manages its own records. The token is stored only in the CloudOps agent
  configuration. Separate tokens give least privilege, separate audit trails and independent
  revocation.
- **CloudOps never modifies zone settings** (SSL mode, HSTS, TLS versions, cache, rules, purges).
- **CloudOps only modifies CloudOps-owned DNS resources**: in V1 the owner creates DNS records
  (in Cloudflare or through CloudForge); later, CloudOps may create and update records for its own
  hostnames, commented `Managed by CloudOps`, and never touches any record without that marker.
- **Origin CA for proxied hostnames** (D-10, PROPOSED): the private key is generated on the server
  and never leaves it; only the CSR goes to Cloudflare; validity up to 15 years. DNS-only hostnames
  use Let's Encrypt (HTTP-01 from the application's own CloudOps site).
- **Cloudflare is not a runtime dependency for normal deployment.** Deployments, worker restarts,
  backups and health checks never call Cloudflare. The API is used only when attaching a hostname
  (zone lookup, record inspection) and when issuing a certificate. If the Cloudflare API is down,
  existing applications keep running and keep deploying.
- Interaction to respect: because CloudForge switches zones to Full (strict), a CloudOps hostname on
  a proxied record must have a valid origin certificate before it is marked live, otherwise
  Cloudflare returns error 526.

| | CloudForge Cloudflare resources | CloudOps Cloudflare resources |
|---|---|---|
| Token | CloudForge's broad token (DNS, zone settings, rules, analytics, …) | Separate narrow token (D-21) |
| Zones | Creates/deletes zones; owns zone settings | Reads zones only |
| DNS records | Records marked `Managed by CloudForge`; its DNS editor | Later: records marked `Managed by CloudOps` |
| Certificates | Origin CA for CloudForge sites | Origin CA for CloudOps hostnames |
| SSL mode, HSTS, cache, rules, purge | ✔ | never |

---

## 11. Existing Docker/Jenkins Applications

- Existing Docker/Jenkins applications **remain where they are**, owned by CloudForge. Example:
  **HanoutPlus**, a Laravel application deployed by a CloudForge-managed Jenkins pipeline with Docker
  Compose. Its main route uses a loopback host port, Reverb has its own routes (`/app`, `/apps`),
  and MySQL and Redis stay private to its Docker network; Supervisor inside the container runs
  Apache, queue workers, Reverb and `schedule:work`.
- **CloudOps does not migrate them automatically.** It does not read their `.env`, touch their
  containers, databases, routes, certificates or DNS records, or claim their hostnames.
- **CloudForge/Jenkins remains responsible for container applications**, including their
  reverse-proxy routes (this is why Reverse proxy is not a CloudOps application type, section 12).
- CloudOps may show these applications' hostnames read-only, so the owner sees every hostname on the
  server in one place.
- **Future migration** of an application from Docker/Jenkins to CloudOps is outside the initial
  scope. If it is ever done, it is an explicit, per-application owner decision with its own plan:
  moving the database out of its container into the host MySQL, storage volumes, Reverb and workers,
  the hostname hand-over between products, DNS cut-over and a way back.

---

## 12. CloudOps Application Types

### V1

**PHP** — a generic PHP application: Git repository, document root (`/` or `public/`), PHP version,
optional Composer install, optional npm build, optional database, configurable shared paths (for
example `uploads/`), optional `.env`, health check path (default `/`).

**Laravel** — a Laravel-specific lifecycle: everything in PHP plus the Laravel creation-time steps
(`APP_KEY`, storage layout), the Laravel deployment steps (section 13), the scheduler, queue workers
and, later, Horizon and Reverb as managed processes. Health check `/up` by default (Laravel 11+).

### Not CloudOps application types

| Type | Why not |
|---|---|
| Reverse proxy to a container or local port | CloudForge already owns container reverse-proxy functionality (Nginx manager, Jenkins domain automation) and tracks those routes in its Runtime model (D-02, PROPOSED) |
| Managed Docker application | Docker belongs to CloudForge |

### Possible later types (not in V1)

Static sites, WordPress, Node.js, Python. Whether they belong in CloudOps is not decided.

---

## 13. Laravel Deployment Model

This is the corrected lifecycle (ACCEPTED by the owner as the deployment specification; details in
CloudOps `docs/02-architecture.md` section 10). Laravel 13 requires PHP 8.3 or later; older
applications may need older PHP versions (section 19).

### Creation time (once)

1. Validate the application name, hostnames, PHP version and repository URL.
2. Create the application's Linux user and directory layout (section 14).
3. Generate a read-only deploy key and check repository access as the application user.
4. Create the database and database user, if requested.
5. Create the initial `shared/.env` (`APP_ENV=production`, `APP_DEBUG=false`, `APP_URL`, database
   settings) and **generate `APP_KEY` once** (32 random bytes, `base64:` prefix, the same value
   `php artisan key:generate` would produce).
6. Create the shared `storage/` tree.
7. Configure PHP-FPM, Nginx and SSL.
8. Prepare the scheduler entry and queue workers; enable them after the first successful deployment.
9. Generate the webhook secret, then start the first deployment.

### Deployment time (every deployment, in this order)

| # | Step | Notes |
|---|---|---|
| 1 | Take the per-application deployment lock | One deployment at a time |
| 2 | Git checkout into a new release directory | Shallow clone of the configured branch; commit SHA recorded |
| 3 | Link shared state | `.env` → `shared/.env`, `storage/` → `shared/storage/` |
| 4 | Composer | `composer install --no-dev --optimize-autoloader --no-interaction --prefer-dist`, with the application's PHP version |
| 5 | npm, when required | `npm ci` when `package-lock.json` exists; `npm run build` when a build script exists and building is enabled |
| 6 | `php artisan storage:link` | Inside the new release |
| 7 | Migrations, only when enabled | `php artisan migrate --force`; off by default. Without `--force`, Laravel cancels migrations in production because it cannot ask for confirmation |
| 8 | Optional deploy hooks | Owner-defined commands, run as the application user, never as root |
| 9 | `php artisan optimize` | Caches config, events, routes and views for this release |
| 10 | Pre-switch health check | Request the health path against the **new** release through its PHP-FPM pool, before it is public; failure aborts and `current` is untouched |
| 11 | Switch `current` | Atomic symlink replacement (section 14) |
| 12 | Restart/reload queue workers | After the switch, because workers load code from `current`; graceful (`SIGTERM`, finish the current job, restart from the new release); Horizon via `horizon:terminate` |
| 13 | Post-switch health check | `GET /up` through Nginx with the application's hostname; retries |
| 14 | Automatic rollback on failure | Point `current` back to the previous release, restart workers again, mark the deployment failed |
| 15 | Cleanup | Keep the last N releases (default 5), never delete the live or previous release |
| 16 | Record the result and release the lock | Status, duration, commit, who triggered it, full masked log |

### `php artisan key:generate` happens only at creation

`APP_KEY` encrypts Laravel's cookies and sessions, values stored with encrypted casts or
`Crypt::encrypt`, and signs signed URLs. Generating a new key on a deployment would:

- log every user out (existing session and remember-me cookies can no longer be decrypted);
- make every encrypted value in the database unreadable, with no way back unless the old key was
  kept;
- invalidate every signed URL already sent (email verification links, temporary download links).

So the key is generated exactly once, stored in `shared/.env`, and kept across all deployments.
`migrate:fresh`, `migrate:reset` and `db:wipe` are never run by a deployment either.

### Rollback and databases

Releases are self-contained (`vendor/` and built assets included), so switching `current` back is
instant. **Databases are never rolled back.** Migrations run before the switch while the previous
release still serves traffic, so they must be backward-compatible with it: add columns and tables
first, remove old ones in a later deployment.

---

## 14. Release Architecture

```text
/var/www/<application>/          ← conceptual layout; the real base path is PENDING (D-15).
                                   The current proposal is /srv/cloudops/apps/<application>/,
                                   to stay clear of anything already in /var/www.
├── releases/
│   ├── release-1/               e.g. 20261007110000/, one self-contained directory per deployment
│   ├── release-2/
│   └── release-3/
├── current -> releases/release-3
├── shared/
│   ├── .env                     mode 0600
│   └── storage/                 survives every deployment
├── logs/                        per-application Nginx and PHP-FPM logs
├── tmp/                         PHP uploads and sessions
└── .ssh/                        deploy key (never leaves the server)
```

- **Atomic(-ish) release switching.** The new symlink is created under a temporary name and then
  renamed over `current`; a rename is atomic, so there is never a moment without a valid `current`.
  It is "atomic-ish" because requests already in progress finish on the old release, while new
  requests use the new one. Nginx passes `$realpath_root` to PHP-FPM, so each release has distinct
  file paths and OPcache never serves code from the previous release, without reloading PHP-FPM
  (D-09, PROPOSED).
- **Rollback.** Pointing `current` at a retained release is the same atomic operation; it is used
  automatically when the post-switch health check fails, and later from the UI.
- **Deployment isolation.** A release is built completely (dependencies, assets, caches) in its own
  directory before it can become live; a failed build never touches the live release.
- **Shared state.** Everything that must survive deployments (`.env`, `storage/`, uploaded files)
  lives in `shared/` and is linked into each release.
- **Old release cleanup.** Only the last N releases are kept (default 5); the live release and the
  one before it are never deleted, so a rollback target always exists.
- Directories are owned by the application's Linux user; the Nginx user can read them through group
  membership; no application can read another application's directory.

---

## 15. Security Architecture

### The core rule

**The CloudOps web application must NOT execute arbitrary root shell commands** (ACCEPTED).

```text
CloudOps Panel                      reachable only through a restricted entry point, 2FA
      ↓
Unprivileged application            Linux user `cloudops`, no sudo, no shell access to the system
      ↓  Unix socket /run/cloudops/agent.sock (root:cloudops 0660, caller verified by peer credentials)
CloudOps Agent                      root; validates, authorizes, audits
      ↓
Allowlisted privileged operations   fixed catalogue, typed parameters, CloudOps-owned resources only
```

The agent exposes explicit operations, never a "run this command" operation. Examples: create
application user, create PHP-FPM pool, create Nginx site, test and reload Nginx, create database
and user, issue certificate, deploy release, revert release, reload service, restart queue worker,
write cron entry, read logs. Commands that come from the owner (deploy hooks, custom cron jobs) run
**as the application's Linux user**, inside its directory, never as root. The agent builds commands
as argument arrays, never by string concatenation, and re-validates every parameter even if the
panel already did.

### Secrets

| Secret | Where it lives | Who can read it |
|---|---|---|
| Cloudflare token (CloudOps' own) | Agent configuration (root, 0600) | Agent only |
| MySQL admin credentials (`cloudops_admin`) | Agent configuration | Agent only |
| Application database credentials | Panel database (encrypted) and the application's `shared/.env` (0600) | Panel, application user |
| Environment variables | Panel database (encrypted) and `shared/.env` | Panel, application user |
| Git deploy keys | The application's `.ssh/` (private key 0600) | Application user only; only the public key is shown |
| Webhook secrets | Panel database (encrypted) | Panel |
| SSH credentials to servers | **Not held by CloudOps.** They stay in CloudForge. | — |
| Cloud provider credentials (Oracle, AWS) | **Never on the server.** They stay in CloudForge. | — |

Secrets are masked in the UI by default and never written to logs, deployment output, audit
entries, the manifest, error messages or API responses. Tests inject a canary secret and check it
never appears in any output.

### Encryption

Secrets in the panel database are encrypted at rest with a key readable only by the panel user;
server-level secrets never leave the agent configuration. Backups that contain secrets are
encrypted before they leave the server.

### Audit logs

Every agent operation is logged (time, panel user, operation, masked parameters, result, duration)
to a root-only file and mirrored into the panel.

### Validation

| Input | Rule |
|---|---|
| Application name (slug) | Strict pattern (proposed `^[a-z][a-z0-9-]{1,24}[a-z0-9]$`), unique |
| Domain | Valid hostname (IDN to punycode), not served by any other Nginx configuration (including CloudForge's), attached to at most one application |
| File paths (file manager, shared paths) | Resolved to a real path that must stay inside the application directory; symlinks leading outside refused |
| Git URL | `https://` or SSH form, no embedded credentials |
| PHP version | One of the versions actually installed |
| Cron schedule | Parsed and validated; command runs as the application user |

### Webhook verification

The webhook endpoint is the only public route of the panel. It accepts `POST` only, verifies the
provider signature with a per-application secret (`X-Hub-Signature-256` HMAC-SHA256 for GitHub,
`X-Gitlab-Token` for GitLab), rejects replays by delivery ID, and is rate-limited.

### Least privilege

- The panel user has no sudo and no shell access to the system.
- Each application runs as its own user, in its own PHP-FPM pool, with `open_basedir` limited to
  its directory.
- `cloudops_admin` can only create users and work on databases named `co\_%`.
- The Cloudflare token has only the scopes listed in section 10.
- The panel itself is never exposed without protection: Cloudflare Access, an IP allowlist, or
  localhost-only through an SSH tunnel (choice pending), plus mandatory TOTP 2FA and rate-limited
  login.
- On SELinux-enforcing servers (Oracle Linux), the agent labels only CloudOps paths and never
  changes system-wide booleans or policy.
- **Separation of credentials across products** (whatever the repository decision): CloudForge's
  cloud, SSH and broad Cloudflare credentials must never be deployed to a server, and the
  internet-facing CloudOps panel must never hold cloud-provider credentials.

---

## 16. CloudOps Agent

- **Local to the server**: a single service (`cloudops-agent`), running as root, reached by the panel
  over a Unix socket.
- **Does not require CloudForge to be running.** It is the component that keeps applications
  deployable, renewable and healthy with the desktop app closed.
- **Performs only explicitly allowed privileged operations** from a documented catalogue (CloudOps
  `docs/02-architecture.md` section 4). Adding an operation means updating the catalogue and its
  tests.
- **Refuses anything outside CloudOps ownership**, including an explicit deny list of
  CloudForge-owned paths, labels and markers.
- **Never installs OS packages** (D-19 decides who does). It checks a host prerequisites contract
  read-only and reports what is missing.
- **Writes a read-only manifest** (`/var/lib/cloudops/manifest.json`, no secrets) describing what
  CloudOps runs, so that CloudForge or a person can read it over SSH.
- **Designed to support multiple servers later**: the operation catalogue does not depend on the
  transport; a later version can expose the same operations over mutually-authenticated TLS, with
  one-time enrollment tokens (which CloudForge could pass to the server when it installs the agent).
- **Must not become a generic remote shell**, now or later.

**Agent technology = Go — PROPOSED — NOT YET FINALLY APPROVED.**

Rationale for the proposal: a single static binary with no runtime dependency on the PHP or Node
versions it manages, a small auditable surface, and good support for Unix sockets, peer
credentials and TLS. Alternatives that the architecture review may weigh: TypeScript/Node (could
share code and contracts with CloudForge's TypeScript packages, but adds a Node runtime the agent
would then depend on, while Node is also something CloudOps manages for builds), Rust, or a PHP
daemon (rejected in the proposal because it would depend on the PHP it manages). The agent
language interacts with the repository decision (section 18).

---

## 17. CloudOps Panel

**Panel technology = Laravel — PROPOSED — NOT YET FINALLY APPROVED.**

Rationale for the proposal: the owner works in Laravel daily; Laravel provides authentication,
queues, scheduling, encryption, validation and a mature 2FA ecosystem out of the box; the panel is
itself a long-running web application on the server, which is what Laravel is built for.

Considerations for the architecture review:

- A TypeScript panel (for example Node with React, reusing `@cloudforge/ui` components and shared
  contracts) would allow more code reuse with CloudForge, but loses the owner's Laravel expertise for
  this product.
- The panel database is open: SQLite keeps the panel independent of the MySQL server it manages;
  MySQL/MariaDB is the conventional Laravel choice.
- The panel is internet-facing (unlike CloudForge), so its security posture is very different:
  restricted access, 2FA, webhook endpoint, rate limits, no high-value infrastructure credentials.
- Whether the owner wants a web panel at all, rather than managing CloudOps from the CloudForge
  desktop UI, is part of the architecture decision (section 18, option E).

Panel responsibilities (whatever the technology): authentication and 2FA, application and hostname
records, encrypted secrets, deployment history and logs, the webhook endpoint, the job queue that
drives agent operations, and the UI described in section 3.

---

## 18. Possible Repository Architectures

> This section analyses options. **It does not choose one.**

### Facts that any option must take into account

- `infrastructure_as_code` is already a **pnpm + Turborepo monorepo** with workspace globs
  `apps/*` and `packages/*`. CloudForge is `apps/desktop` plus eight `packages/*` (`@cloudforge/*`),
  all TypeScript, consumed as source. CI runs format, lint, typecheck, tests and build; a tag-driven
  release workflow builds the signed Windows installer and the auto-update feed.
- CloudForge is a **desktop application** (runs on the owner's Windows machine, on demand).
  CloudOps is a **server application** (runs on the VPS, always on, internet-facing panel or at
  least a public webhook endpoint). They are **two different deployables** under every option.
- The proposed CloudOps stack is **Laravel (panel) + Go (agent)** (both PROPOSED). With that stack,
  code reuse with CloudForge's TypeScript is limited to **contracts** (data formats, schemas, naming
  rules), not libraries. With a TypeScript panel or agent, real library reuse becomes possible. The
  repository decision and the technology decision (D-13) are therefore linked.
- Some future changes are naturally cross-product (CloudForge track F1–F5: hosting-stack Ansible
  profiles that install the CloudOps agent, CloudForge reading the CloudOps manifest, a shared Nginx
  lock, agent enrollment).

### Invariants that hold whatever is chosen

1. Each server resource and each hostname has exactly one owner (sections 6–8).
2. CloudOps does not depend on CloudForge at runtime (PROPOSED D-18, strongly indicated by the facts
   in section 5).
3. CloudForge's cloud, SSH and broad Cloudflare credentials never reach a server; the CloudOps panel
   never holds cloud-provider credentials.
4. The agent exposes only allowlisted operations, never a shell.
5. CloudForge's existing safety guarantees (legacy mode, ownership markers, preview/apply tokens)
   are not weakened.

---

### Option A — Completely separate repository

```text
infrastructure_as_code/      CloudForge (unchanged)
CloudOps/                    CloudOps: panel, agent, docs, audit tooling
```

CloudOps is an independent application that integrates with CloudForge only through documented
contracts on the server (ownership markers, prerequisites contract, manifest).

| Dimension | Assessment |
|---|---|
| Ownership | Clearest: repository boundary = product boundary = resource boundary |
| Deployment | Fully independent: Linux server artifacts (agent binaries per architecture, panel release) vs CloudForge's Windows installer |
| Lifecycle | Independent release cadence; CloudForge's release workflow untouched |
| Security | Strongest separation of code, dependencies and CI secrets (Windows code-signing secrets never visible to CloudOps workflows) |
| Coupling | Lowest; only through contracts. Risk: contracts drift because nothing compiles them together |
| Testing | Each product tests on its own; cross-product scenarios (e.g. a CloudForge Nginx restore with CloudOps installed) need deliberate integration tests on a VM |
| Versioning | Independent semver; a compatibility note per contract version (e.g. manifest `format`) |
| Developer experience | Two repositories; can still sit side by side in one editor workspace; cross-product changes need two pull requests |
| Future multi-server | Unaffected; agent enrollment through CloudForge becomes a coordinated two-repository change |
| Independent evolution | Highest |
| Reuse of CloudForge code | Lowest: patterns and ideas only (e.g. the Nginx validate-and-rollback transaction, Origin CA flow), unless contracts are extracted |
| Risk of a monolith | None |
| Risk of duplicated functionality | Medium for code (CloudOps re-implements things like a Cloudflare client or Origin CA issuance); responsibility duplication is still controlled by the ownership rules |

---

### Option B — CloudOps as a major module inside `infrastructure_as_code`

```text
infrastructure_as_code/
    cloudforge/              current apps/ and packages/ moved under here
    cloudops/                CloudOps: panel, agent, docs
```

Two products side by side at the top of one repository.

| Dimension | Assessment |
|---|---|
| Ownership | Folder-level; repository-level assets (CI, issues, releases, tags) become shared, so ownership is blurrier |
| Deployment | One repository producing a Windows installer and Linux server artifacts; release workflows must be split by path and tag prefix |
| Lifecycle | Shared history; independent only if tags and workflows are namespaced (`cloudforge-v…`, `cloudops-v…`). The current release workflow triggers on any semantic tag matching the desktop version and would have to change |
| Security | CI secrets are shared unless each workflow's permissions and environments are scoped carefully |
| Coupling | Easier to share contracts; also easier to import the other product's internals by accident |
| Testing | One CI can run cross-product tests; CI becomes longer and must be path-filtered |
| Versioning | Per-product versions needed inside one repository |
| Developer experience | One clone and one workspace; but moving CloudForge into `cloudforge/` means changing the pnpm workspace, Turborepo, electron-builder paths, CI and release workflows of a released product with an auto-update feed: significant churn and risk |
| Future multi-server | Neutral; cross-product changes can be one pull request |
| Independent evolution | Medium |
| Reuse of CloudForge code | Easy for contracts; library reuse only if CloudOps uses TypeScript |
| Risk of a monolith | Medium |
| Risk of duplicated functionality | Lower: both products are visible side by side |

---

### Option C — Monorepo with separate applications

```text
infrastructure_as_code/
    apps/
        desktop/             CloudForge (existing; "cloudforge" in the owner's sketch)
        cloudops-panel/
        cloudops-agent/
    packages/
        shared/  core/  ui/  …          existing CloudForge packages
        cloudops-contracts/           manifest schema, ownership markers, agent operation schemas
```

CloudOps applications slot into the existing `apps/*` and `packages/*` layout without moving
CloudForge. Non-TypeScript applications (Laravel, Go) would be wrapped by a small `package.json`
that delegates to Composer or Go so Turborepo can orchestrate them, or kept outside the pnpm
workspace.

| Dimension | Assessment |
|---|---|
| Ownership | Per application directory; shared packages become joint ownership and need clear rules |
| Deployment | Separate deployables from one repository; separate release workflows triggered by path or tag prefix |
| Lifecycle | Per-application versions possible (tag prefixes or a changeset tool) |
| Security | Same CI-secret considerations as B; bundler boundaries must guarantee that no desktop credential code ends up in a server application |
| Coupling | Compile-time coupling through shared packages: good for contracts, risky for domain logic (e.g. CloudOps importing `@cloudforge/core` would tie it to CloudForge's domain model). Import rules (lint) would be needed |
| Testing | Turborepo can run only affected tests; contract tests between products are natural |
| Versioning | Monorepo-wide or per package |
| Developer experience | Best if CloudOps is TypeScript; mixed toolchains (pnpm, Composer, Go) if the proposed Laravel/Go stack is kept |
| Future multi-server | Neutral to good: agent changes and the CloudForge profile that installs the agent (F1/F5) can change in one pull request |
| Independent evolution | Medium |
| Reuse of CloudForge code | Highest among repository options if TypeScript: `@cloudforge/shared` (Result, errors, IDs), `@cloudforge/ui` (React design system), the Cloudflare adapter in `@cloudforge/service-providers` (DNS, Origin CA). With Laravel/Go: contracts only |
| Risk of a monolith | Medium to high unless import boundaries are enforced |
| Risk of duplicated functionality | Lowest |

---

### Option D — `infrastructure_as_code` stays the infrastructure project; CloudOps is a separate deployable application that shares selected libraries/contracts

```text
infrastructure_as_code/      CloudForge (infrastructure), unchanged except for consuming contracts
CloudOps/                    separate application (panel + agent)
shared contracts, one of:
    - a contracts package published from one repository and consumed by the other
    - a small third repository (e.g. cloudops-contracts)
    - JSON Schema files vendored into both, with contract tests
```

| Dimension | Assessment |
|---|---|
| Ownership | Clear products; the contracts have explicit joint ownership and versioning |
| Deployment | Independent |
| Lifecycle | Independent, with contract versions (manifest `format`, agent API version) |
| Security | Strong separation, as in A |
| Coupling | Explicit and minimal: only the contracts |
| Testing | Contract tests on both sides (schema validation, shared fixtures) |
| Versioning | Semver on the contracts plus a compatibility matrix |
| Developer experience | Medium: publishing/consuming contracts adds steps (private registry, git dependency, or vendoring) |
| Future multi-server | Good: enrollment and manifest specifications live in the contracts that CloudForge's future profiles consume |
| Independent evolution | High |
| Reuse of CloudForge code | Targeted: contracts, and selected libraries if the language allows |
| Risk of a monolith | Low |
| Risk of duplicated functionality | Medium-low |

---

### Option E — Agent-centric: CloudOps server agent, management UI inside CloudForge (added for completeness)

```text
infrastructure_as_code/
    apps/desktop/            CloudForge + a new "Hosting" module (CloudOps UI), talking to the agent
                             over CloudForge's existing pinned-SSH transport
    …
cloudops-agent               (in the monorepo or separate) on each server: owns applications,
                             webhooks, deployments, renewals, workers, backups
```

There is no CloudOps web panel in this option. The always-on work still happens on the server
(agent), because the desktop app is not always running; a small public endpoint for Git webhooks
is still needed.

| Dimension | Assessment |
|---|---|
| Ownership | Server resources still owned by CloudOps (the agent); the UI is part of CloudForge |
| Deployment | The desktop installer gains a hosting module; the agent ships separately |
| Lifecycle | UI tied to CloudForge releases; agent independent |
| Security | No internet-facing admin panel: the largest reduction in attack surface of all options; management reuses CloudForge's encrypted credentials and host-key pinning; only the webhook endpoint is public |
| Coupling | High: CloudForge becomes the client of the agent, which effectively creates the "CloudForge ↔ server API" that does not exist today (over SSH) |
| Testing | Agent tests on VMs; UI tests in CloudForge's suite |
| Versioning | Agent protocol versioned; UI follows CloudForge |
| Developer experience | One TypeScript UI codebase; agent in its own language |
| Future multi-server | Natural: CloudForge already manages many targets; no central web panel to host |
| Independent evolution | Low for the UI |
| Reuse of CloudForge code | Highest: UI, projects, targets, credentials, SSH, Cloudflare adapter, activity log |
| Risk of a monolith | High for the CloudForge desktop app, which absorbs a large new domain |
| Risk of duplicated functionality | Lowest |
| Fit with the desired experience | Weak: no browser or phone access, management only from the Windows desktop, team access later is hard; the hPanel-like web experience the owner described would not exist |

---

### Comparison summary

Qualitative only; "better" depends on which dimensions the owner values most.

| Dimension | A | B | C | D | E |
|---|---|---|---|---|---|
| Clarity of ownership | High | Medium | Medium | High | Medium |
| Deployment independence | High | Medium | Medium | High | Low (UI) / High (agent) |
| Security separation | High | Medium | Medium | High | High (no web panel), but CloudForge grows |
| Coupling (lower is safer) | Low | Medium | Medium–High | Low | High |
| Reuse of CloudForge code | Low | Medium | High if TS | Medium | Highest |
| Monolith risk (lower is better) | None | Medium | Medium–High | Low | High |
| Code duplication risk (lower is better) | Medium | Low–Medium | Low | Medium–Low | Lowest |
| Churn to CloudForge today (lower is better) | None | High (restructure) | Low–Medium | Low | Medium–High |
| Matches a web hosting panel | Yes | Yes | Yes | Yes | No |

### What should drive the decision

1. **Panel and agent languages (D-13).** Laravel/Go makes reuse mostly about contracts, which
   lowers the benefit of C and E; TypeScript raises it.
2. **Is a web panel required** (remote and mobile access, future team members)? If yes, E can only
   be a complement, not the CloudOps UI.
3. **Churn tolerance for CloudForge**, which already has a working signed release and auto-update
   pipeline. B requires restructuring it; C adds to it; A, D leave it alone.
4. **Security separation**: an internet-facing server application and a desktop app holding cloud
   and SSH credentials have very different threat models and CI-secret needs.
5. **Frequency of cross-product changes** (F1–F5): frequent atomic changes favour a monorepo;
   rare ones favour separate repositories with contracts.
6. **One developer working with several Claude sessions**: a single editor workspace can be had with
   any option (sibling folders), so convenience alone does not require merging repositories.
7. **Toolchain mixing**: pnpm/Turborepo with Composer and Go in one repository is workable but adds
   CI and tooling complexity.

**NO FINAL DECISION HAS BEEN MADE.**

---

## 19. Critical Architectural Questions

The receiving session must answer, or bring to the owner, at least the following.

### Architecture and integration

1. **Should CloudOps be a separate application or part of `infrastructure_as_code`?** (Options A–E,
   section 18; decision D-22.)
2. **Should CloudForge expose an API in the future?** Today there is none. Option E would effectively
   create one (CloudForge as a client of the CloudOps agent over SSH). A CloudForge API would also
   change what "integration" means for every other option.
3. **Should CloudOps remain completely independent of CloudForge at runtime?** (D-18, proposed yes,
   because CloudForge is not always running.)
4. **How should CloudOps coexist with CloudForge's Nginx ownership?** (D-17 proposes CloudOps files
   outside `/etc/nginx` plus one include file; is a shared lock (F3) or a CloudForge change to exclude
   CloudOps from restores wanted?)

### Infrastructure and prerequisites

5. **Who installs PHP, MySQL/MariaDB, Node and Composer?** (D-19: CloudForge Ansible profiles or a
   documented manual setup; the CloudOps agent never installs packages.)
6. **How are CloudOps prerequisites provisioned and verified?** (Host prerequisites contract;
   CloudForge profile F1 or manual; agent check.)
7. **Which OS distributions are officially supported?** (D-20: Debian/Ubuntu and RHEL-family, given
   that the CloudForge-built server runs Oracle Linux 9 on ARM; SELinux handling.)
8. **How many PHP versions must be supported**, and which ones? (Laravel 13 needs PHP 8.3+; existing
   or future applications may need older versions.)
9. **Should MySQL be server-native or Docker-based?** (D-11 proposes native, on localhost; CloudForge
   currently provisions PostgreSQL as a container, and HanoutPlus runs MySQL in its own container.)
10. **Where should application data live?** (D-15: base directory; `/srv/cloudops/apps/<app>` proposed.)

### Data and resilience

11. **How should backups survive VPS replacement?** (CloudForge can replace or destroy the server,
    and Pulumi replaces Oracle instances when their metadata such as the SSH key changes. Off-server
    backups are proposed for V1 (D-23); which storage, which retention, who holds the keys?)
12. **What is the production VPS sizing requirement?** (The known CloudForge server has 1 OCPU,
    6 GB RAM, 50 GB disk, already running Docker applications.)

### Security and access

13. **How should the CloudOps panel authenticate with the server agent?** (Unix socket with peer
    credentials in V1; mutual TLS and enrollment tokens for multiple servers.)
14. **How should CloudOps authenticate with Cloudflare?** (D-21: separate narrow token, stored only
    in the agent configuration.)
15. **How is the panel itself reached?** (Cloudflare Access, IP allowlist or SSH tunnel, plus 2FA;
    D-26.)

### Product scope

16. **How should CloudOps handle multiple VPSs in the future?** (Central panel with agents over mTLS;
    agents installed through CloudForge with enrollment tokens; or option E's desktop-centric model.)
17. **Is a web panel required**, or is managing CloudOps from the CloudForge desktop acceptable?
18. **Which languages for the panel and agent?** (D-13, linked to question 1.)
19. **What is the policy for existing Docker/Jenkins applications** in the long term: stay
    permanently, or become candidates for an explicit, per-application migration?
20. **Which CloudForge changes are acceptable** (track F1–F5), and when?

---

## 20. Current Known Risks

| # | Risk | Description | Impact | Proposed mitigation | Status |
|---|---|---|---|---|---|
| 1 | Nginx ownership conflict | CloudForge's rollback/restore replaces the whole `/etc/nginx`; its editor can overwrite `nginx.conf` | CloudOps sites silently disappear | CloudOps files outside `/etc/nginx` (D-17); include-file checks; optional shared lock (F3) | Mitigated in design, not yet tested |
| 2 | Server replacement destroys CloudOps data | Pulumi replace/destroy recreates an empty server | Loss of applications, databases, panel state | Off-server backups in V1 (D-23); rule: fresh backup before any replace/destroy; future CloudForge warning (F2) | Open |
| 3 | CloudForge is not always running | Its timers (Let's Encrypt renewal, Cloudflare sync) stop when the desktop app is closed | Anything depending on CloudForge at runtime would stall | CloudOps independent at runtime (D-18); server-side renewal for CloudOps certificates | Mitigated in design |
| 4 | CloudForge has no runtime API | No way for CloudOps to request infrastructure changes programmatically | Infrastructure requests are manual | Owner-facing "requests for CloudForge" checklist; manifest for CloudForge to read; possible future API (question 2) | Accepted limitation for V1 |
| 5 | Both products manage the same resource | Same hostname, same DNS record, same certificate, same Nginx file | Conflicts, overwrites, flapping drift | Exactly-one-owner rule; prefixes/markers; hostname conflict detection; deny lists | Mitigated in design |
| 6 | Small VPS resources | 1 OCPU / 6 GB RAM already running Docker applications | Builds (Composer/npm) and extra PHP-FPM/MySQL may not fit | Audit; sizing decision (question 12); ondemand PHP-FPM; possibly a separate server | Open, pending audit |
| 7 | PHP version compatibility | Laravel 13 needs PHP 8.3+; older apps may need older versions; RHEL needs Remi packages for parallel versions | Applications that cannot run | Decide supported versions (question 8); prerequisites contract | Open |
| 8 | MySQL installation responsibility | Neither product installs MySQL today | No database for CloudOps applications | D-19 / D-11 | Open |
| 9 | SSL ownership | Both products can issue certificates; CloudForge sets zones to Full (strict) | Overwrites, or 526 errors for CloudOps hostnames without valid certificates | Certificates partitioned by hostname; CloudOps-owned paths; certificate before a hostname goes live (D-10) | Mitigated in design |
| 10 | Cloudflare ownership | CloudForge owns zones and settings and marks its DNS records | Zone-wide changes affecting CloudOps hostnames; record conflicts | Separate token, no zone settings, own marker for future records (D-21) | Mitigated in design |
| 11 | Backup strategy | Nothing backs up application data today | Data loss | Backups in V1 with off-server copies and restore tests (D-23) | Open (design only) |
| 12 | Security of privileged operations | The agent runs as root on a server with an internet-facing panel | Full server compromise if the boundary fails | Allowlisted typed operations, validation, peer-credential socket, no shell, audit log, restricted panel access, 2FA (D-03, D-25) | Mitigated in design |
| 13 | Existing production applications | HanoutPlus and others run on the same server | Outage if CloudOps changes something it does not own | Read-only audit first; ownership rules; no automatic migration (D-24); test on a disposable VM | Mitigated in design |
| 14 | Port 80/443 ownership | CloudOps needs host Nginx; the server might use a containerised Nginx or another proxy | CloudOps cannot serve sites | Audit (D-14); any edge change done through CloudForge | Pending audit |
| 15 | SELinux on Oracle Linux | Enforcing mode blocks unlabelled paths and sockets | Requests or deployments fail | Agent labels only CloudOps paths (D-20) | Pending audit |
| 16 | Concurrent Nginx edits | No shared lock between products | One side's validation fails | Atomic writes; retries; shared lock (F3) | Partially mitigated |
| 17 | Repository decision coupled to technology choice | Reuse benefits depend on language | A decision made on one axis may undermine the other | Decide D-13 and D-22 together | Open |

---

## 21. Current Decisions

IDs D-01 to D-21 match CloudOps `docs/02-architecture.md`. D-22 to D-27 and the REJECTED rows
are recorded here as part of the handoff. No PROPOSED decision has been turned into ACCEPTED.

| ID | Decision | Status | Notes |
|---|---|---|---|
| D-01 | PHP and Laravel run natively on Nginx + PHP-FPM; Docker is not required for them | **ACCEPTED** | Owner: "Do NOT make Docker mandatory for standard PHP/Laravel applications" |
| D-02 | Reverse-proxy routes to containers stay in CloudForge; CloudOps has no Reverse proxy application type and lists those routes read-only | **PROPOSED** | Reverses an earlier accepted "Reverse proxy in V1"; the owner's handoff brief lists it as the current proposal, but final approval is pending |
| D-03 | Unprivileged panel; root agent with an allowlisted, typed operation catalogue | **ACCEPTED** | Owner requirement |
| D-04 | One Linux user and one PHP-FPM pool per application | **ACCEPTED** | Owner requirement (per-application users) |
| D-05 | CloudOps runs its own PHP-FPM master per PHP version | **PROPOSED** | Avoids interrupting other PHP-FPM services on reloads |
| D-06 | Release-based deployments: releases, shared `.env`/storage, atomic `current`, health checks, automatic revert, rollback-ready | **ACCEPTED** | Owner requirement |
| D-06a | `key:generate` only at creation; `migrate --force` only when explicitly enabled; workers restarted on every deployment | **ACCEPTED** | Owner requirement |
| D-07 | CloudOps manages only resources it created or explicitly imported, recognized by prefix/path/marker | **ACCEPTED** (principle) | Exact prefixes (`co-`, `co_`, `cloudops-`) are PROPOSED details |
| D-08 | Queue workers run as systemd units, not under Supervisor | **PROPOSED** | |
| D-09 | Deployments do not reload PHP-FPM; Nginx passes `$realpath_root` | **PROPOSED** | |
| D-10 | Certificates: Cloudflare Origin CA for proxied hostnames, Let's Encrypt HTTP-01 for DNS-only; CloudOps-owned paths; renewal on the server | **PROPOSED** | Revised after the CloudForge review (originally DNS-01) |
| D-11 | One MySQL/MariaDB server on the host, installed by the infrastructure layer; `cloudops_admin` limited to `co\_%` | **PENDING** | VPS audit and D-19 |
| D-12 | Server-level secrets (MySQL admin, Cloudflare token) only in the agent configuration | **PROPOSED** | |
| D-13 | Panel in Laravel; agent in Go | **PROPOSED — NOT YET FINALLY APPROVED** | Linked to D-22 |
| D-14 | Edge: host Nginx must own ports 80/443; any change through CloudForge | **PENDING** | VPS audit |
| D-15 | Base directory (proposed `/srv/cloudops/`) | **PENDING** | VPS audit |
| D-16 | Layering: CloudForge = infrastructure, CloudOps = hosting; exactly one owner per resource and hostname | **PROPOSED** | |
| D-17 | CloudOps Nginx sites and snippets in `/etc/cloudops/nginx/`, loaded by one include file in `conf.d` | **PROPOSED** | Because CloudForge restores replace `/etc/nginx` |
| D-18 | CloudOps never depends on CloudForge at runtime; integration through markers, prerequisites contract and manifest | **PROPOSED** | |
| D-19 | Who installs the hosting stack (PHP, MySQL/MariaDB, Composer, Node, agent): CloudForge profiles or manual | **PENDING** | Owner decision |
| D-20 | Supported OS families (Debian/Ubuntu, RHEL-family) and SELinux handling | **PENDING** | VPS audit |
| D-21 | Separate, narrowly scoped Cloudflare token for CloudOps; CloudOps never changes zone settings | **PROPOSED** | |
| D-22 | Repository/module architecture (options A–E) | **PENDING** | Main task of the receiving session |
| D-23 | Off-server backups are part of V1 | **PROPOSED** | Because of server replacement risk |
| D-24 | Existing Docker/Jenkins applications stay with CloudForge; no automatic migration | **ACCEPTED** | Owner requirement |
| D-25 | Security is foundational from day one (2FA, restricted panel access, encrypted secrets, audit log) | **ACCEPTED** | Owner requirement |
| D-26 | Panel access method: Cloudflare Access, IP allowlist or SSH tunnel | **PENDING** | |
| D-27 | Panel database: SQLite or MySQL/MariaDB | **PENDING** | Linked to D-13 |
| R-01 | Docker mandatory, or one container per PHP site, as the standard runtime | **REJECTED** | Owner |
| R-02 | Panel executing arbitrary shell commands as root; a generic "run command" agent operation | **REJECTED** | Owner |
| R-03 | Running `key:generate` on deployments | **REJECTED** | Owner |
| R-04 | Automatically modifying or migrating existing infrastructure or applications | **REJECTED** | Owner |
| R-05 | Rebuilding the full cPanel/Hostinger feature set in V1 | **REJECTED** | Owner |

---

## 22. Current VPS Information

**Target CloudOps VPS: `PENDING AUDIT`.**

Nothing about the target server has been verified, and it has not been confirmed which server
CloudOps will run on. The only server information available comes from CloudForge's own notes
about the server it built for HanoutPlus: Oracle Linux 9.7 on ARM (`VM.Standard.A1.Flex`), 1 OCPU,
6 GB RAM, 50 GB boot volume, ports 22/80/443 open, Docker Engine, Docker Compose and Git installed.
This is a **candidate**, not a confirmed target, and its current state is unverified.

The read-only audit must happen before any final infrastructure decision (D-11, D-14, D-15, D-20,
PHP versions, Node version, sizing):

- Tool: CloudOps `scripts/vps-audit.sh` v1.1. Read-only: no file writes (not even temporary files),
  no service restarts, no package installation, no network calls; secrets masked; anything not safely
  inspectable marked `[NOT INSPECTED]`. It reports CloudForge's footprint on the server and tags
  every Nginx file by owner.
- Recommended run: from the owner's machine, `ssh <user>@<server> 'sudo bash -s' < scripts/vps-audit.sh > vps-audit-report.txt`
  (nothing stored on the server).
- Complement: information that CloudForge already holds reliably (targets, Runtime mode, Nginx
  sites, certificates, Jenkins pipelines, Cloudflare records, provider firewall) is copied from the
  CloudForge app into CloudOps `docs/03-infrastructure-audit.md` section 0.
- The audit has **not been run**. It runs only when the owner decides.

---

## 23. What Has Already Been Built

**CloudOps application: NOT BUILT.**

No production CloudOps code exists: no panel, no agent, no installer. Nothing has been executed on
any server. CloudForge has not been modified.

Current work consists of:

| Artifact | Location (`E:\CloudOps`) | Status |
|---|---|---|
| Documentation (source of truth for CloudOps) | `CLAUDE.md`, `README.md`, `docs/01-overview-and-scope.md`, `docs/02-architecture.md`, `docs/03-infrastructure-audit.md` (template, pending), `docs/04-roadmap.md`, `docs/05-cloudforge-integration.md` | Draft for owner approval |
| This handoff | `docs/CLOUDOPS-HANDOFF.md` | For the receiving session |
| Architecture investigation | Captured in the documents above | Done |
| CloudForge analysis | `docs/05-cloudforge-integration.md`, sections 5–11 of this document | Done (read-only, at `a5034a1`) |
| Read-only VPS audit tooling | `scripts/vps-audit.sh` v1.1 | Syntax-checked; run without root in a local WSL Ubuntu (all 22 sections, no errors); masking and parsing tested against mock files; **not yet run on a real server**; root-only paths untested against real services |
| Background research | `docs/Investigation_GPT.md` | Superseded where it disagrees with docs 01–05 |

`E:\CloudOps` is not a Git repository yet. `.gitignore` excludes audit reports; `.gitattributes`
keeps shell scripts with LF line endings.

---

## 24. What The Next Claude Session Must Do

The Claude session working on `infrastructure_as_code` must:

1. **Read this entire document.**
2. **Inspect the existing CloudForge repository**, verifying the facts in section 5 and Appendix A
   against the current code (CloudForge is under active development).
3. **Understand CloudForge before proposing changes**: its ownership rules, Runtime model, Nginx
   transactions, release pipeline and project isolation.
4. **NOT start implementing CloudOps immediately.**
5. **Decide whether CloudOps should be** a separate repository, a module, a monorepo application,
   or another architecture (options A–E in section 18, or a better one).
6. **Explain the decision**: which dimensions mattered, which options were rejected and why, and how
   it interacts with the panel/agent languages (D-13).
7. **Update the architecture documentation** (the CloudOps documents listed in Appendix B and any
   CloudForge documents affected), keeping PROPOSED decisions PROPOSED until the owner approves them.
8. **Identify reusable CloudForge components** (for example `@cloudforge/shared`, `@cloudforge/ui`,
   the Cloudflare adapter, the Nginx validate-and-rollback approach, host-firewall knowledge) and
   whether they can actually be reused given the chosen languages.
9. **Identify boundaries that must remain separate** whatever the layout: the invariants in
   section 18, the ownership table in section 8, the credential separation in section 15.
10. **Produce a final architecture proposal** for the owner (the brief for this step was cut off in
    transmission; this is the evident intent): the recommended repository/module architecture, the
    resulting technology choices, the CloudForge changes it implies (if any), the answers or
    recommendations for the questions in section 19, and the updated decision table.
11. **Stop and wait for the owner's explicit approval** before implementing anything, moving files,
    changing CloudForge behaviour or touching any server.

The receiving session must not:

- run the VPS audit or connect to any server without the owner's instruction;
- change CloudForge's behaviour, release pipeline or safety guarantees as a side effect of this
  analysis;
- turn PROPOSED or PENDING decisions into ACCEPTED ones on its own;
- treat `docs/Investigation_GPT.md` as authoritative.

---

## Appendix A — CloudForge evidence pointers

Paths are relative to the CloudForge repository root. Line numbers refer to commit `a5034a1` and
may have moved.

| Topic | Where |
|---|---|
| Nginx transaction (backup of `/etc/nginx`, validate, rollback, reload) | `packages/deployment/src/ssh-nginx-manager.ts` (≈378–411), `packages/deployment/src/nginx-exec-script.ts` (rollback ≈85–88; container mount probe ≈25–62) |
| Nginx site file naming and markers | `packages/deployment/src/nginx-site-file.ts`; `packages/core/src/application/nginx/nginx-service.ts` (≈330–360, 497–575) |
| Certificates (Certbot container, Origin CA) | `packages/deployment/src/ssh-certificate-manager.ts`; `packages/core/src/application/ssl/ssl-service.ts` |
| Desktop-only timers (SSL renewal, Cloudflare sync) | `apps/desktop/src/main/container.ts` (≈426–460, ≈569–598) |
| Cloudflare adapter and DNS ownership marker | `packages/service-providers/src/cloudflare/cloudflare-api-provider.ts`; `cloudflare-dns-automation-service.ts` (core application layer) |
| Runtime model, modes, ownership labels | `packages/core/src/application/vps-runtime/vps-runtime-plan.ts`, `runtime-ownership.ts`, `runtime-operations.ts`, `runtime-plan-service.ts` |
| Ansible profiles | `packages/deployment/src/ansible-playbooks.ts`, `packages/deployment/src/ssh-ansible-manager.ts` |
| Host firewall | `packages/deployment/src/host-firewall-script.ts` |
| Jenkins | `packages/core/src/application/jenkins/jenkins-pipeline-service.ts`, `packages/deployment/src/jenkins-http-manager.ts` |
| Preflight (supported OS, checks) | `packages/deployment/src/vps-preflight.ts` |
| IPC contract and project gating | `apps/desktop/src/shared/ipc/contract.ts`, `apps/desktop/src/main/ipc/registry.ts` |
| Secret encryption | `apps/desktop/src/main/security/secret-cipher.ts` |
| CloudForge's own documentation | `docs/VPS-RUNTIME.md`, `docs/NGINX-MANAGER.md`, `docs/SSL-DOMAINS.md`, `docs/CLOUDFLARE.md`, `docs/JENKINS-PIPELINES.md`, `docs/ANSIBLE.md`, `docs/RUNTIME-PRODUCTION-READINESS-AUDIT.md`, `docs/automation-studio/` |

## Appendix B — CloudOps documents

| Document | Contents |
|---|---|
| `CLAUDE.md` | Working rules, including "never modify what CloudForge owns" |
| `docs/01-overview-and-scope.md` | Purpose, users, use cases, V1 goals and non-goals, application types, relationship with CloudForge |
| `docs/02-architecture.md` | Panel, agent, security boundary, ownership, runtime model, Laravel deployment specification, decisions D-01 to D-21 |
| `docs/03-infrastructure-audit.md` | Audit template (pending), how to run the audit, what to copy from CloudForge |
| `docs/04-roadmap.md` | Phases 0–17, milestones, exit criteria, CloudForge track F1–F5 |
| `docs/05-cloudforge-integration.md` | CloudForge capabilities, ownership boundary, interfaces, lifecycle, failure scenarios, multi-server |
| `scripts/vps-audit.sh` | Read-only audit, v1.1 |

## Appendix C — Proposed CloudOps names and paths (PROPOSED)

| Resource | Name / location |
|---|---|
| Base directory | `/srv/cloudops/` (PENDING, D-15) |
| Application directory | `/srv/cloudops/apps/<slug>/` |
| Linux user/group | `co-<slug>` |
| Nginx | `/etc/cloudops/nginx/sites/<slug>.conf`, `/etc/cloudops/nginx/snippets/`, include `/etc/nginx/conf.d/zz-cloudops.conf` |
| PHP-FPM | `cloudops-php<ver>-fpm.service`, config `/etc/cloudops/php/<ver>/`, sockets `/run/cloudops/php/<slug>.sock` |
| Databases/users | `co_<slug>` |
| systemd units | `cloudops-*` |
| Cron | `/etc/cron.d/cloudops-<slug>` |
| Certificates | `/etc/cloudops/certs/<hostname>/`, ACME state `/etc/cloudops/acme/` |
| Agent | `cloudops-agent.service`, socket `/run/cloudops/agent.sock`, config `/etc/cloudops/agent.yaml` |
| Manifest | `/var/lib/cloudops/manifest.json` |
| Logs | `/var/log/cloudops/`, `<app>/logs/` |
| DNS records (later) | Comment `Managed by CloudOps` |

## Appendix D — Glossary

| Term | Meaning |
|---|---|
| Agent | The CloudOps root service on the server that performs allowlisted operations for the panel |
| Panel | The CloudOps web application (unprivileged) |
| Release | A complete, self-contained build of an application in its own directory |
| `current` | The symlink pointing to the live release |
| PHP-FPM pool | A group of PHP worker processes for one application, with its own user and settings |
| Origin CA | Cloudflare-issued certificate trusted only by Cloudflare's edge, for proxied hostnames |
| HTTP-01 | Let's Encrypt challenge served over port 80 from the site itself |
| Full (strict) | Cloudflare SSL mode requiring a valid origin certificate |
| VPS target | CloudForge's saved SSH destination for a server |
| `VpsRuntimePlan` | CloudForge's per-server model of applications, routes, certificates, DNS and Docker topology |
| Legacy mode | CloudForge Runtime mode in which it only inspects and never writes (default) |
| Ownership marker | A name prefix, path, label or comment that identifies which product owns a resource |
| Manifest | CloudOps' secret-free description of what it runs on a server, readable over SSH |
| Prerequisites contract | The list of what the infrastructure layer must provide before CloudOps can run |
