# CloudOps — Clean Server Baseline

| | |
|---|---|
| **Date** | 2026-10-07, 22:1x UTC |
| **Server** | `always-free-arm` — `51.170.131.166` (private `10.0.1.222`), user `ubuntu` |
| **Purpose** | The "before" snapshot. Every future change to this server is measured against this document |
| **Mode** | **Read-only.** Nothing installed, started, stopped or modified. No file written on the server |
| **Verdict** | **CLEAN and READY.** One blocker to resolve before Nginx will serve anything — §4 |

---

## 1. Provisioned infrastructure (from CloudForge)

| | |
|---|---|
| CloudForge project | `CloudOps` (separate workspace, no passkey) |
| Pulumi stack | `cloudops-3c5e0943/development` |
| Oracle tenancy | `ouhnanabil6@gmail.com` — **a different tenancy from the `abdohero` server**, so its Always Free allowance is independent |
| Region | `af-casablanca-1` |
| Shape | `VM.Standard.A1.Flex` — **2 OCPUs, 12 GB RAM** |
| Image | `ubuntu-24.04` (ARM64) |
| Boot volume | **200 GB** |
| Network | VCN `10.0.0.0/16`, public subnet `10.0.1.0/24`, internet gateway, route table |
| OCI ingress | **TCP 22, 80, 443 from `0.0.0.0/0` — and nothing else** |
| SSH key | `ouhnanabil6` · ed25519 |
| Resources | 8 created, 38s |

The separate tenancy resolves the storage-allowance concern raised before provisioning: the 200 GB
boot volume draws on this account's own allowance, not the one `abdohero` consumes.

## 2. Verified system state

| Fact | Value |
|---|---|
| OS | Ubuntu 24.04 LTS, ARM64 (`aarch64`) |
| CPU | 2 cores |
| RAM | **11 GiB total — 433 MiB used, 11 GiB available** |
| **Swap** | **0 B — none** |
| Disk | `/dev/sda1` 193 G — **2.3 G used, 191 G available (2 %)** |
| Inodes | 1 % used |
| Reboot required | **No** |
| Failed units | **None** |
| Running services | **24**, all stock Ubuntu plus the Oracle Cloud agent |
| AppArmor | Loaded, 124 profiles, **25 in enforce** — all stock. No `docker-default`, because there is no Docker |
| Users | `opc` (1000), `ubuntu` (1001, passwordless sudo) |
| Groups | `ubuntu` is in `sudo` only. **No `docker` group exists** |
| apt sources | **`ubuntu.sources` only** — no third-party repositories |

This is a materially better baseline than `abdohero`, where 9.3 GiB "available" was measured with
two stacks down. Here, **11 GiB available is the real figure** because nothing is running.

## 3. Confirmed absent — the server is genuinely clean

| Component | State |
|---|---|
| Nginx | **Absent** — no `/etc/nginx`, nothing on :80/:443 |
| Docker / containerd | **Absent** — no CLI, no group, no service |
| Jenkins | **Absent** |
| PHP / PHP-FPM | **Absent** — no `/etc/php` |
| MySQL / MariaDB | **Absent** — no binaries, no `/var/lib/mysql` |
| Node / npm / Composer | **Absent** |
| Go | Absent (not needed — the agent ships as a static binary) |
| `/opt/cloudforge`, `/var/lib/cloudforge` | **Absent** — CloudForge has touched nothing beyond provisioning |
| `/etc/cloudops` | **Absent**, as expected |
| Git | **Present**, 2.43.0 (Ubuntu base) |

Candidate base directories:

| Path | State |
|---|---|
| **`/srv`** | **Exists, empty** — `/srv/cloudops/` (D-15) collides with nothing |
| `/opt` | Exists, empty |
| `/var/www` | **Does not exist** |

Listening sockets — the entire set:

```
tcp  0.0.0.0:22    sshd
tcp  127.0.0.53:53 systemd-resolved      (loopback)
tcp  127.0.0.54:53 systemd-resolved      (loopback)
tcp  0.0.0.0:111   rpcbind               (see §5)
```

**Nothing on 80 or 443.** No hostnames are served. No `server_name` exists anywhere, so there is no
possibility of a hostname conflict on this box.

## 4. ⚠️ One blocker — the host firewall allows only port 22

The OCI security list permits 22, 80 and 443. **The host firewall does not.** Its INPUT chain:

```
ct state related,established   accept
ip protocol icmp               accept
iifname "lo"                   accept
tcp dport 22 ct state new      accept
                               reject with icmp type host-prohibited   ← everything else
```

There is **no rule for 80 or 443**. This is the Oracle Ubuntu image default, and it is exactly the
situation CloudForge's own documentation warns about:

> *"Open required cloud and host firewall ports separately. Installing a service does not silently
> change OCI security lists, UFW, firewalld, or DNS."*

**Consequence:** installing Nginx will produce a service that starts correctly, listens on 80 and
443, and is unreachable from the internet. The failure looks like a DNS or Cloudflare problem and is
neither.

The firewall is `iptables-nft` — the real table is nftables driven through the iptables
compatibility layer, the same shim case as `abdohero`, and the case CloudForge's shared
host-firewall builder is written to detect (nftables before iptables).

**This is CloudForge-owned territory. It needs owner approval and is listed in §6 as action A1.**

## 5. Minor observations

| # | Observation | Assessment |
|---|---|---|
| 1 | `rpcbind` running, listening `0.0.0.0:111` | **Not reachable externally** — 111 is absent from the OCI ingress list and rejected by the host firewall. Still an unnecessary service on a host that will never use NFS. Optional hardening |
| 2 | `packagekit.service` running | Stock Ubuntu; a package-management daemon that is not needed on a server. Optional |
| 3 | **No swap** | On a box that will run Composer and npm builds, a memory spike is an OOM kill rather than a slowdown. Proposed in the startup plan §20 |
| 4 | `unattended-upgrades` active | Security updates apply automatically. Worth a deliberate decision once PHP and MySQL are installed — an unattended PHP upgrade restarts PHP-FPM |

## 6. Proposed next actions — **each needs explicit approval**

**None performed.** Every one is a write.

| ID | Action | Owner | Why |
|---|---|---|---|
| **A1** | **Open host firewall ports 80 and 443** | CloudForge | Without it Nginx serves nothing. Do it through CloudForge (VPS Runtime → connectivity, or the Ansible Nginx profile with host-firewall management) so the rule carries CloudForge's marker |
| **A2** | **Install Nginx** via CloudForge's Ansible Nginx profile | CloudForge | The only base component CloudOps requires. Native host Nginx must own :80/:443 |
| **A3** | Add a swap file | ⬜ owner | §5 item 3 |
| **A4** | Decide and install the hosting stack — PHP 8.3, MySQL/MariaDB, Composer, Node | **⬜ D-19 — still undecided** | Nothing exists; this is the gating decision |
| **A5** | Disable `rpcbind` (and optionally `packagekit`) | ⬜ owner | Optional hardening |
| **A6** | Register this server as a CloudForge VPS target and record the pinned host key | CloudForge | Already done automatically — the stack output shows `VpsTarget · always-free-arm` Ready |

**Not proposed, and not to be installed on this server:** Docker, Jenkins, Dockhand, Portainer,
PostgreSQL. The absence of Docker is a deliberate security property of this box — no root-equivalent
group, and no DNAT path that bypasses the host firewall (which is how `dockhand` ended up publicly
reachable on `abdohero`).

## 7. Decisions this baseline unblocks

| ID | Status after this baseline |
|---|---|
| **D-14** | **Answerable: yes** — nothing contends for :80/:443, and no containerised proxy exists. Native Nginx will own the edge once installed |
| **D-15** | **Answerable: `/srv/cloudops/`** — `/srv` is empty and `/var/www` does not exist |
| **D-20** | **Answerable: Ubuntu 24.04 ARM64, AppArmor**, 25 stock enforce profiles, no custom policy needed for V1 |
| **D-11** | **No constraint** — no database of any kind is installed. Free choice of MySQL or MariaDB |
| **D-19** | **Still the gating owner decision.** Nothing of the hosting stack exists |

## Audit integrity statement

Nothing was installed, started, stopped, enabled, disabled, upgraded or removed. No file was created
or modified on the server, including temporary files — the audit script was piped over stdin. No
firewall rule was changed. The only state change is the SSH login record.
