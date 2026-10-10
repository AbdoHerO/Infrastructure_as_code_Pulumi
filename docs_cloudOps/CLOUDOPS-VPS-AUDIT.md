# CloudOps — Read-Only VPS Audit of `abdohero`

| | |
|---|---|
| **Date** | 2026-10-07, 16:30 UTC |
| **Server** | `abdohero` — `84.8.217.33`, connected as `ubuntu` |
| **Mode** | **Strictly read-only.** Nothing installed, started, stopped, modified or written. No file was created on the server |
| **Method** | A purpose-written read-only script piped over `ssh … 'bash -s'` (stdin — nothing stored on the server). Scripts and raw output retained locally |
| **Authorized by** | Owner, 2026-10-07 |
| **Status** | **FINDINGS ONLY.** No installation. No write operation. No CloudOps component deployed |
| **Superseded as a target** | **2026-10-07: CloudOps will run on a new dedicated VPS, not `abdohero`.** This audit remains the reference for CloudForge's server footprint, the integration surface, and the operational findings in §1.7 and §5, which still need owner action on `abdohero` itself |

### What was run, and what was not

I did **not** run `scripts/vps-audit.sh` v1.1. It is untested against a real server with root, and
running an untested 22-section script as root against a box carrying production traffic is a larger
risk than running a small set of commands reviewed line by line. The scripts actually executed are
retained locally and can be committed to the CloudOps repository when it exists.

**Commands deliberately not run**, because they could modify the system — each is listed in §5 as a
proposed action instead: `apt update`, adding any repository, `systemctl start/stop/restart/enable`,
`docker` lifecycle commands, `nginx -s reload`, anything writing to `/etc`, any package operation,
and any reboot. `nginx -t` **was** run: it parses configuration and neither writes nor reloads.

---

# 1. Verified facts

Everything in this section was observed directly. Nothing is inferred.

## 1.1 Platform

| Fact | Value |
|---|---|
| OS | **Ubuntu 24.04.4 LTS** (noble) |
| Kernel | `6.17.0-1011-oracle` |
| Architecture | **aarch64 / ARM64**, ARM Neoverse-N1, KVM guest |
| CPU | **2 cores** |
| RAM | **11 GiB total** (`MemTotal` 12,506,738,688 B) |
| **Swap** | **0 B — none configured** |
| Root filesystem | `/dev/sda1` ext4, **193 G total, 27 G used, 167 G available (14 %)** |
| Inodes | 5 % used — not a constraint |
| Uptime | 84 days; load average 0.03 |
| Reboot | **Pending** (`/var/run/reboot-required` present) |
| Time sync | `systemd-timesyncd` active |

## 1.2 Edge, firewall and exposure — **D-14 and D-20 are answered**

| Fact | Value |
|---|---|
| **:80 and :443** | **Owned by native host `nginx`** (processes `nginx`, not `docker-proxy`) |
| nginx | **1.24.0-2ubuntu7.18, arm64**, Ubuntu package, `nginx.service` active |
| **`include /etc/nginx/conf.d/*.conf;`** | **Present, `nginx.conf` line 59** (line 60 also includes `sites-enabled/*`) |
| `nginx -t` | **Passes** |
| Host firewall | **`iptables-nft`** — the real table is nftables, driven through the iptables compatibility layer. `nft` reports: *"table ip filter is managed by iptables-nft, do not touch!"* |
| `ufw` | **Not installed** |
| INPUT policy | `accept`, with a final `reject with icmp host-prohibited`. Explicit accepts: **22, 80, 443, 8080** |
| Mandatory access control | **AppArmor** — module loaded, 130 profiles, **32 in enforce**, all stock Ubuntu plus `docker-default`. **No SELinux** (`getenforce` absent) |

**Publicly reachable ports**, combining the OCI security list (22, 80, 443, 8080, 3000) with the host firewall:

| Port | Listener | Reachable from the internet? |
|---|---|---|
| 22 | `sshd` | Yes |
| 80 / 443 | native `nginx` | Yes |
| **8080** | **`java` (Jenkins)**, `*:8080` | **Yes** — accepted by both firewalls; counter shows **2,521,291 packets** |
| **3000** | **`docker-proxy` → `dockhand` container**, bound `0.0.0.0` and `[::]` | **Yes** — Docker's DNAT path bypasses the INPUT chain; the DOCKER chain shows 20,478 accepted packets |
| 111 | `rpcbind`, bound `0.0.0.0` | **No** — not in the OCI list, and the host INPUT chain rejects it |

## 1.3 The hosting stack CloudOps needs — **none of it exists**

| Component | State |
|---|---|
| PHP | **NOT INSTALLED** — no binary, no `/etc/php` |
| PHP-FPM | **NOT INSTALLED** — no units |
| MySQL / MariaDB | **NOT INSTALLED** — no `mysql`, `mariadb`, `mysqld`, `mariadbd`, `mysqladmin`; no `/var/lib/mysql`; no units |
| Node / npm | **NOT INSTALLED** |
| Composer | **NOT INSTALLED** |
| Go | Not installed (not needed — the agent ships as a static binary) |
| Git | **Present**, 2.43.0 |
| apt third-party sources | Only `docker.sources` and `jenkins.sources`. **No PHP repository configured** |

## 1.4 Candidate base directories — **informs D-15**

| Path | State |
|---|---|
| **`/srv`** | **Exists and is completely empty** |
| `/var/www` | Exists, contains only `html` (the nginx default site) |
| `/opt` | `cloudforge`, `containerd`, `unified-monitoring-agent` |
| `/etc/cloudops` | **Absent** — CloudOps is not installed, as expected |

## 1.5 CloudForge's footprint

| Path | Contents |
|---|---|
| `/opt/cloudforge/` | `ansible/`, `apps/`, `certs/`, `www/` |
| `/opt/cloudforge/certs/live/` | `app.hanoutplus.ma`, `hanoutplus.ma`, `hanoutplus.ma-0001`, `interview.zincolo.com`, `tujjar.store` |
| `/var/lib/cloudforge/` | `nginx/` (the Nginx backup archives) |
| `/etc/nginx/conf.d/` | `cloudforge-api.zincolo.com.conf`, `cloudforge-app.hanoutplus.ma.conf`, `cloudforge-hanoutplus.ma.conf`, `cloudforge-interview.zincolo.com.conf`, `cloudforge-tujjar.store.conf` |

**Every hostname served on this box**, from a full `server_name` scan:

`hanoutplus.ma` · `app.hanoutplus.ma` · `tujjar.store` · `interview.zincolo.com` ·
`api.zincolo.com` · plus `server_name _;` in `sites-available/default` (the catch-all).

`dash.zincolo.com` and `www.zincolo.com` have **no Nginx site**. No hostname conflicts exist for
CloudOps today — but every one of the above is CloudForge's.

## 1.6 Docker and the four stacks

Docker **29.6.1**, `overlayfs`, root `/var/lib/docker`. 18 containers, 8 running, 29 images.

| Stack | State |
|---|---|
| **lp-tifaw** | **Healthy.** `app` on `127.0.0.1:8090`, `db` (mysql:8.0) internal only |
| **interview-hub** | **Healthy.** `web` on `127.0.0.1:8091`, `ai` on `127.0.0.1:8092`, `qdrant` internal |
| **sm-erp** | **BROKEN** — see §1.7 |
| **HanoutPlus** | **DOWN** — see §1.7 |
| **dockhand** | Up 2 months, healthy, **published `0.0.0.0:3000`** |

Disk usage by Docker — **relevant to backup sizing and to §1.8**:

| Item | Size |
|---|---|
| **Build cache** | **16.06 GB** |
| All named volumes combined | **≈ 620 MB** |
| `hanoutplus_mysql_data` | 232.1 MB |
| `lp-tifaw_dbdata` | 224.7 MB |
| `dockhand_dockhand_data` | 88.29 MB |
| `hanoutplus_redis_data` | 46.8 MB |
| `hanoutplus_storage` | 24.57 MB |
| `lp-tifaw_uploads` | 1.22 MB |
| `sm-erp_pgdata`, `sm-erp_backend-storage`, `interview-hub_aidata` | **0 B** |

**Backing up every piece of application data on this server is under a gigabyte.** That removes
the main practical objection to doing it before any CloudOps work begins.

## 1.7 Two stacks are not running — discovered during the audit

These are **not** CloudOps concerns, and nothing was changed. They are reported because they affect
the sizing picture and because you should know.

**`sm-erp` — the database is crash-looping, so most of the stack never started.**

`sm-erp-db-1` is `Restarting`. Its log:

> *"There appears to be PostgreSQL data in `/var/lib/postgresql/data` (unused mount/volume) … The
> suggested container configuration for 18+ is to place a single mount at `/var/lib/postgresql`."*

`postgres:18` changed the expected mount layout. The compose file mounts
`pgdata:/var/lib/postgresql/data`, which 18 no longer uses. Consequences:

- `sm-erp-db-1` restarting; `migrate`, `backend`, `web`, `queue`, `scheduler` all stuck in `Created`
  — they never started, because they wait on the database and on `migrate` completing.
- `sm-erp_pgdata` is **0 B** — the database never initialised, so **no data has been lost**.
- `backoffice` and `landing` are up on 8101/8102 but report **unhealthy**.
- `api.zincolo.com` has an Nginx site but **nothing listens on 8100**, so that hostname returns 502.
  It also has **no certificate** in `/opt/cloudforge/certs/live/`.

I reviewed that compose file during the sm-erp deployment work and did not catch this; the volume
mount predates my changes, but I shipped it.

**`HanoutPlus` — all four containers exited about four weeks ago (2026-09-06).**

`hanoutplus.prod` exited **137** (SIGKILL). Its final log lines show queue workers failing
repeatedly (`exit status 1`) immediately before. `redis`, `mysql` and `landing` exited cleanly (0).

**Root cause: UNKNOWN.** No OOM entries survive in `dmesg` or the journal for that date, so I cannot
say whether 137 was the OOM killer or a stop timeout. `hanoutplus.ma` and `app.hanoutplus.ma` have
Nginx sites and valid certificates, so **both hostnames are currently down.**

## 1.8 Memory reality — correcting my own earlier figure

`free -h` currently reports **9.2–9.4 GiB available**. That measurement is taken while **HanoutPlus
is entirely down and five of eight sm-erp containers have never started.**

The headroom figure I used in the startup plan (§20) is therefore **optimistic**. With both stacks
healthy — a Laravel app, MySQL, Redis, a landing page, PostgreSQL, php-fpm, two Node servers —
real available memory would be materially lower, and there is **no swap**. The true baseline cannot
be known until those stacks are running again.

## 1.9 Users, groups, cron

| Fact | Value |
|---|---|
| Interactive users | `opc` (uid 1000), `ubuntu` (uid 1001) |
| Service users | `jenkins` (110), `www-data` (33) |
| **`docker` group** | **`ubuntu`, `jenkins`, `opc`** — three accounts with root-equivalent access |
| `sudo` group | `ubuntu` (passwordless) |
| `/etc/cron.d` | Only stock entries (`.placeholder`, `e2scrub_all`, `sysstat`) |
| Root crontab | None |
| Failed systemd units | **None** |
| `unattended-upgrades` | **Active** |

---

# 2. Existing assumptions — confirmed, corrected or still open

| # | Assumption (from the handoff) | Outcome |
|---|---|---|
| 1 | Server is Oracle Linux 9.7 ARM, 1 OCPU, 6 GB, 50 GB | **REFUTED.** Ubuntu 24.04.4, 2 cores, 11 GiB, 193 G. Already corrected before the audit |
| 2 | SELinux enforcing must be handled (D-20) | **REFUTED.** AppArmor, all-stock profiles. Materially less work |
| 3 | Host Nginx might not own the edge (D-14, risk 14) | **CONFIRMED SAFE.** Native nginx owns :80/:443 |
| 4 | `nginx.conf` ships `include conf.d/*.conf` | **CONFIRMED**, line 59. D-17's single-include mechanism is viable |
| 5 | MySQL might already exist and conflict (D-11) | **REFUTED — nothing installed.** Free choice, no conflict. The two containerised MySQLs publish no host port |
| 6 | PHP might need a third-party repo with uncertain arm64 coverage | **PARTLY OPEN.** No PHP at all today. Ubuntu 24.04 ships PHP 8.3 in its own repositories, which covers current Laravel. Multi-version support is still **[NOT INSPECTED]** |
| 7 | `/srv/cloudops` might collide with something (D-15) | **CONFIRMED SAFE.** `/srv` exists and is empty |
| 8 | CloudForge's footprint is confined to its own paths | **CONFIRMED.** `/opt/cloudforge`, `/var/lib/cloudforge`, `conf.d/cloudforge-*.conf` only |
| 9 | Small VPS may not fit builds (risk 6) | **PARTLY REFUTED, PARTLY UNKNOWN.** 2 cores / 11 GiB / 167 G free is adequate; but §1.8 means the true headroom is unmeasured, and swap is zero |
| 10 | Backups of existing stacks would be a large job | **REFUTED.** All application data is under 1 GB |
| 11 | CloudForge's host-firewall logic must detect nftables before iptables | **CONFIRMED RELEVANT.** This host is exactly the `iptables-nft` shim case its code comments describe |

**[NOT INSPECTED]** — could not be verified without writing to the system:

| Item | Why | How to verify later |
|---|---|---|
| arm64 coverage of a third-party PHP repository | Requires adding the repository and `apt update`, which writes to `/var/lib/apt` | On a disposable ARM64 VM, not here |
| Whether the 2.5 M packets on :8080 are legitimate | Needs log analysis beyond this audit's scope | Jenkins access logs |
| True memory headroom with all stacks healthy | Two stacks are down | Re-measure after §5 action A1 |
| Whether `hanoutplus.prod`'s 137 was an OOM | No OOM records retained for that date | Would need to reproduce |

---

# 3. Proposed decisions — **PROPOSED, not accepted**

Based only on verified facts.

| ID | Proposal | Evidence |
|---|---|---|
| **D-14** | **Close as CONFIRMED.** Native host Nginx owns the edge; CloudOps can use Unix-socket PHP-FPM as designed | §1.2 |
| **D-20** | **Restate for Ubuntu.** Supported OS for V1: Ubuntu 24.04 LTS on arm64. MAC handling is **AppArmor**, and because every enforced profile is stock, CloudOps paths need no policy work in V1 — confirm on the disposable VM | §1.2 |
| **D-15** | **`/srv/cloudops/`** — `/srv` is empty, so no collision, and it stays clear of `/var/www` and `/opt/cloudforge` | §1.4 |
| **D-11** | **Native MySQL or MariaDB on the host, bound to localhost.** Nothing is installed, so there is no conflict and no migration. The containerised MySQLs belonging to lp-tifaw and HanoutPlus publish no host port and are unaffected | §1.3, §1.6 |
| **D-19** | **CloudForge installs the hosting stack via a new Ansible profile (F1).** The server already carries CloudForge's Ansible runtime at `/opt/cloudforge/ansible`, and CloudForge is the documented owner of OS packages. Hand-installing would create a second package authority on a box CloudForge manages | §1.3, §1.5 |
| **PHP** | **Ubuntu's own PHP 8.3 for V1**, single version. It satisfies current Laravel with no third-party repository, no arm64 uncertainty and no extra attack surface. Add multi-version support only when a real application needs it | §1.3, §2 item 6 |
| **Swap** | **Add a modest swap file before CloudOps runs builds.** Zero swap on a box that has already had a SIGKILL means a memory spike is a kill, not a slowdown — and the kernel does not necessarily pick CloudOps' process | §1.1, §1.7, §1.8 |

---

# 4. Owner decisions required

### Newly answerable after this audit

| ⬜ | Decision | Recommendation from the evidence |
|---|---|---|
| ⬜ | **D-14** | Close as confirmed |
| ⬜ | **D-20** | Ubuntu 24.04 arm64; AppArmor, no custom policy for V1 |
| ⬜ | **D-15** | `/srv/cloudops/` |
| ⬜ | **D-11** | Native MySQL **or** MariaDB — ⬜ which one is still yours |
| ⬜ | **D-19** | CloudForge Ansible profile (F1) |
| ⬜ | PHP versions | Ubuntu PHP 8.3 only, for V1 |
| ⬜ | Swap | Add a swap file — ⬜ size |

### Still open, unchanged by the audit

| ⬜ | Decision |
|---|---|
| ⬜ | **D-26** — panel access method (Cloudflare Access recommended) |
| ⬜ | **D-27** — panel database |
| ⬜ | **D-23** — off-server backup destination, retention, key custody |
| ⬜ | Panel hostname and zone |
| ⬜ | Node version |
| ⬜ | Confirmation of D-02, D-05, D-08, D-09, D-10, D-17, D-18, D-21 |

---

# 5. Actions requiring explicit approval

**None of these was performed.** Each is a write operation.

### Urgent — about the server as it stands, not about CloudOps

| ID | Action | Why |
|---|---|---|
| **U1** | **Review `dockhand` on `0.0.0.0:3000`.** A Docker management UI is reachable from the internet. Docker control is equivalent to root on this host, and it carries all four stacks | The single most serious finding. Options: close 3000 in the OCI security list and reach it over an SSH tunnel; or put it behind Nginx with authentication |
| **U2** | **Review Jenkins on `:8080`**, publicly reachable, 2.5 M packets counted | Same class of exposure. Reaching it through an authenticated HTTPS hostname instead is the usual answer |
| **A1** | **Fix `sm-erp`**: the `postgres:18` volume mount. `pgdata` is 0 B, so no data is at risk | `api.zincolo.com` is 502 and five containers have never started |
| **A2** | **Decide HanoutPlus's fate** — it has been down four weeks and two live hostnames with valid certificates point at it | |

### Before any CloudOps work on this server

| ID | Action |
|---|---|
| **B1** | Back up all application data — under 1 GB total — and **prove a restore** |
| **B2** | Take the pending reboot at a quiet moment |
| **B3** | Reclaim the **16.06 GB** Docker build cache (`docker builder prune`) — a write, and CloudForge's territory, so yours to approve |
| **B4** | Add swap (proposed in §3) |
| **B5** | Install the hosting stack per D-19 — nothing exists today |
| **B6** | Install the single `zz-cloudops.conf` include in `/etc/nginx/conf.d/` (D-17) |

### Never without separate, explicit approval

Installing the agent; creating any Linux user; creating any database; writing any Nginx site;
issuing any certificate; starting any CloudOps service; touching anything CloudForge owns.

---

## Audit integrity statement

Nothing was installed, started, stopped, enabled, disabled, upgraded, downgraded or deleted. No
file was created or modified on the server, including temporary files — the audit script was piped
over stdin. No firewall rule, container, image, volume, network, database, website or credential was
touched. No reboot. No CloudOps component exists on the server.

The only state change of any kind is the SSH login record, which is unavoidable for any inspection.
