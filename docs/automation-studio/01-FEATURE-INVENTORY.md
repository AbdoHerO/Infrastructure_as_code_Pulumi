# Phase 0 — Complete Feature Inventory (from source code)

Every feature below was verified in code. Grouped by module. ✅ = fully implemented; ⚙️ = implemented
but not surfaced as a dedicated UI action; 📅 = background/scheduled.

## Projects
- ✅ Create project (name, region, environment, provider link, description; Zod-validated)
- ✅ List / get / count projects
- ✅ Edit project (name/region/environment/description) with live-stack protection: identity,
  region and provider fields are **blocked with ConflictError while a managed stack exists**
  (`ProjectConfigurationService`), with plan-region rewrite + rollback on failure
- ✅ Link/unlink cloud provider credential
- ✅ Delete project (cascades: managed-stack check, VPS target cleanup, deployments cascade in DB)

## Secrets / Credentials
- ✅ 12 credential kinds with schema-driven forms: oracle, aws, azure, github, jenkins, cloudflare,
  openai, anthropic, dockerhub, gitlab, ssh, ssh-password (`CREDENTIAL_SCHEMAS`)
- ✅ Create credential (encrypted at rest: safeStorage/OS keychain, or AES-256-GCM fallback)
- ✅ List (summary only, never secrets) / reveal (decrypt) / delete
- ✅ Keychain status indicator (`security:status`)
- ✅ Portable encrypted backup export/import (scrypt + AES-256-GCM, ≥12-char passphrase)

## SSH Keys
- ✅ Generate (ed25519 / RSA-3072, optional passphrase) — stored as encrypted `ssh` credentials
- ✅ Import existing private key (PEM/OpenSSH/PKCS8 conversion)
- ✅ Copy public/private key, export private key to file (0600), materialize to `~/.ssh`
- ✅ Delete (type-name-to-confirm)
- ⚙️ Resolve authentication (key or password) for SSH adapters; find by public key (used by target sync)

## Infrastructure (Pulumi → Oracle / AWS)
- ✅ Declarative plan editor: network (VCN/VPC), subnet, firewall, compute, block volume
- ✅ Plan persistence per project (`PlanStore`, stored in Setting table as `plan:<projectId>`)
- ✅ Client + server plan validation (`validatePlan`: unique names, resolvable refs)
- ✅ Preview (streams engine events; per-resource change analysis: create/update/delete/replace,
  changed properties, destructive flags) → issues one-use preview token
- ✅ Apply (requires matching preview token + plan fingerprint; streams; syncs VPS targets after)
- ✅ Destroy (project stack; cleans VPS targets + deletes plan)
- ✅ Refresh / drift detection
- ✅ Outputs (secrets masked as `[secret]`; extracts SSH connection hints `<name>PublicIp`/`<name>SshUser`)
- ✅ Managed stacks list (reads Pulumi checkpoint files directly from disk) + destroy any stack incl. orphans
- ✅ Built-in templates: oci-always-free-arm, web-server, ai-server, database, k8s-node, aws-ec2-web-server
- ✅ Custom templates: save current plan as template, apply, delete (Template table)
- ✅ Engine availability check (requires `pulumi` CLI on PATH)
- ✅ SSH connection panel: auto-materialize matching key, copy exact SSH command

## Cloud Providers (Oracle OCI + AWS)
- ✅ Test connection / account info
- ✅ List regions, availability domains, shapes, images (AWS: AL2023 + Ubuntu curated list)
- ✅ List instances; instance actions start/stop/reboot (OCI polls to target state)
- ✅ Terminate instance (OCI: `preserveBootVolume=false`, polls until gone, 10-min timeout;
  type-name-to-confirm in UI; activity-audited)
- ✅ List resources: VCNs/VPCs, subnets, internet gateways, volumes
- Provider registry: `oracle`, `aws` implemented; azure/gcp/hetzner/etc. only as credential kinds/labels

## Firewall Manager (OCI security lists)
- ✅ Read live instance firewall (instance → VNIC → subnet → security list chain)
- ✅ Edit rules (direction, protocol tcp/udp/icmp/all, CIDR, port range, stateless) with
  template presets (SSH/HTTP/HTTPS/Docker/K8s/MySQL/Postgres/Redis/Mongo)
- ✅ Security warnings (open SSH, duplicates, overlaps)
- ✅ Apply with **optimistic concurrency** (`expectedRules` compared to live before write); audited
- ✅ Rollback preparation from activity history snapshots

## Deployments (SSH step runner)
- ✅ 6 built-in templates: docker-host, nginx, node, nextjs, wordpress, ollama (ordered shell steps)
- ✅ Host-key inspection (trust-on-first-use fingerprint)
- ✅ Run deployment (streams step/stdout/stderr; 15-min step timeout; records Deployment row)
- ✅ Cancel running deployment (AbortController per streamId)
- ✅ History per project; global count; crash recovery (`failRunning` marks interrupted runs failed at startup)

## VPS Targets (shared SSH connection catalog)
- ✅ CRUD saved targets (name, host, port, user, SSH credential, pinned host-key SHA-256)
- ✅ Preflight report persistence (`lastPreflight`); reset on connection change
- ✅ Managed targets: auto-created from stack outputs after apply (retry SSH inspect 20×3s),
  reconciled at startup, removed when stacks/projects disappear; `vpsTargets:changed` push event

## Ansible (remote, self-contained)
- ✅ 5 profiles (embedded YAML in TS): docker, dockhand, portainer, jenkins, nginx — each with a
  typed variable surface (`AnsibleVariableSpec`)
- ✅ Bootstrap: installs python3/venv on target (apt/dnf/yum with lock-wait), creates
  `/opt/cloudforge/ansible` venv, installs ansible-core 2.16–2.21
- ✅ Preflight: 20+ fact checks (OS/arch/python/memory/disk/DNS/HTTPS-egress/firewall/SELinux/
  port-busy/repo reachability) → ready / needs-repair / blocked
- ✅ Repair (preflight → bootstrap → re-preflight)
- ✅ Run profile: SFTP-upload playbook + vars.json → `--syntax-check` → run `-i localhost, -c local`
  → post-check service health; auto-runs docker dependency for dockhand/portainer; streams; cancellable
- ✅ Profile states: live installed/running/version/port/firewall per profile
- ✅ Jenkins service actions: verify / restart; access details (URL + initial admin password)
- ✅ Nginx via ansible profile: list managed sites, upsert domain route, remove route
- ✅ Status check (is CloudForge ansible installed)

## Nginx Manager (direct SSH, transactional)
- ✅ Inspect overview (native vs docker, version, running, config-test, site/SSL counts)
- ✅ Sites: list managed (base64 marker headers) + discovered external; create/edit full site
  (upstream, timeouts, body size, headers, location blocks, websocket, SSL, redirect, compression,
  cache, extra directives); delete
- ✅ Main config editor: read, validate-and-save, test-and-reload
- ✅ Every mutation is a **transaction**: auto-backup → apply → `nginx -t` → rollback on failure → reload
- ✅ Live status (workers, connections, stub_status), logs (access/error, filter, live tail, export)
- ✅ Backups: list, compare with current, restore (tar.gz at `/var/lib/cloudforge/nginx/backups`)

## SSL & Domains (Certbot via Docker over SSH)
- ✅ DNS verification (domain IPs vs target IPs; Cloudflare-aware: detects proxied records and SSL
  mode; certificate requirement recommendation; UI polls 5s up to 5 min)
- ✅ Issue certificate (webroot; opens 80/443 firewall; streams Certbot output; wires ACME webroot
  into the Nginx site; flips site to SSL after issue; persists to `settings.ssl.managed`)
- ✅ List certificates (openssl x509 parse: issuer, SANs, wildcard, key algo, days remaining)
- ✅ Export PEM / CRT / KEY / ZIP (base64 download)
- 📅 Auto-renew (`renewDue`): interval from settings (default hourly check config), renews certs
  nearing expiry, reloads Nginx, audits — runs on a container `setInterval` + 30s post-startup shot

## Cloudflare
- ✅ Test connection, dashboard aggregate, account resolution
- ✅ Zones: list, create (full type), delete
- ✅ DNS: list (500/page), create/update/delete records, batch actions (proxy on/off, TTL, delete),
  automatic DNS wizard (`ensureDns` with propagation polling every 5s up to configured timeout),
  verify (`verifyDns` against public DNS)
- ✅ Zone settings: SSL mode, min TLS, TLS 1.3, HSTS, always-HTTPS, auto-HTTPS-rewrites, brotli,
  dev mode, security level, browser check, cache level, browser cache TTL — read + patch
- ✅ Purge cache (purge everything)
- ✅ Security overview: WAF rulesets, rate limits, IP access rules, country blocks, IP lists, bot management
- ✅ Analytics (GraphQL): requests/bandwidth/threats/visitors, daily series, country/URL/status breakdowns
- ✅ Page rules CRUD; Redirect rules CRUD (dynamic-redirect ruleset)
- ✅ Platform summary: Workers scripts + routes, R2 buckets, Access apps + policies, Gateway rules (read-only)
- 📅 Auto-sync: container timer diffs zones/DNS/settings/security snapshots → `cloudflare:changed`
  events + optional activity records

## Jenkins Pipelines
- ✅ Test connection (version via `X-Jenkins` header; loopback-URL guard)
- ✅ Save pipeline: ensures folder `cloudforge-<slug>-<id8>`, folder-scoped GitHub PAT credential,
  upserts pipeline job (SCM Jenkinsfile or inline Groovy with env wrapper), build parameters
  (string/boolean/choice/password), blocks secret-looking env vars
- ✅ Domain integration: optional Cloudflare DNS ensure + Nginx site upsert
  (`127.0.0.1:<applicationPort>`, websocket) + `HOST_PORT` build param sync
- ✅ Trigger build (validated parameters), status (job + last build, polled 15s in UI)
- ✅ Delete (removes job, prunes empty folder, deletes record)
- ✅ Jenkins install/manage via Ansible profile (Java 21, systemd port override, firewall) +
  verify/restart service actions + initial admin password reveal

## Containers (Docker over SSH)
- ✅ List all containers (`docker ps -a` JSON)
- ✅ Start / stop / restart / remove (force)
- ✅ Logs (tail 1–5000, timestamps), stats (no-stream JSON)
- ✅ Deploy Compose project (YAML validated ≤512 KB, written to `/opt/cloudforge/compose/<project>`,
  `up -d --remove-orphans`, 10-min timeout)

## SSH Terminal
- ✅ Interactive PTY (xterm-256color) to saved fingerprint-verified targets only
- ✅ Open/write/resize/close; data streamed over `terminal:data`/`terminal:closed`; closeAll on dispose
- ✅ Raw terminal data deliberately never logged

## Activity / Audit
- ✅ Append-only activity feed (type, message, projectId?, JSON metadata), `recordSafe`
  fire-and-forget hook used by ~all mutating services; list limit clamp 1–1000
- ✅ UI: dashboard timeline + Logs page with search/filter/export

## Logs
- ✅ pino file logging (trace level) + stdout (info); 10 MiB rotation; retention pruning
- ✅ Renderer log viewer: tail 300 (3s poll), copy path, open folder
- ✅ Renderer→main error forwarding (`logs:report`)
- ✅ Every IPC call logged (channel, duration, ok/error — payloads never logged)

## Settings
- ✅ Sections: appearance (theme, reduced motion), deployment (default region), logs (retention),
  updates (check-on-startup, auto-download), ssl (auto-renew, renew-before-days, interval, managed list),
  cloudflare (13 settings: default cred/zone, TTL, proxy, propagation, auto-sync, automatic DNS/SSL/
  redirect, SSL mode, cache TTL, dev mode, confirm-delete, activity logging)
- ✅ Stored as single JSON blob in Setting table; patch-merge over defaults; side effects on update
  (log pruning, update-manager reconfigure)

## Backup / Restore
- ✅ Create: DB snapshot (`VACUUM INTO`) + portable encrypted secrets envelope + manifest → save dialog
- ✅ Restore: manifest validation (product/format), pre-restore safety backup, path-traversal guards,
  secret re-import, container re-init, app relaunch; rollback on failure

## Plugins / Marketplace
- ✅ Declarative catalog (currently one plugin: `theme-nord`); install / enable / disable / uninstall
- ✅ Active manifests consumed globally (theme contribution); no arbitrary code execution

## Updates
- ✅ electron-updater against GitHub Releases; states idle/checking/available/downloading/downloaded/error
- ✅ Check / download / restart-and-install; startup check (packaged only); autoDownload preference
- ✅ Live progress push (`updates:state` event)

## App / Diagnostics
- ✅ App info (version, build number, git commit, platform), copy diagnostics (no app state)
- ✅ Manual data synchronization (`app:synchronize` = managed-target reconcile + Cloudflare sync)
- ✅ Safe external links (https-only allowlist: github, releases)
- ✅ Command palette (⌘K, navigation only), theme cycling, contextual per-route help

## Documentation (in-app)
- ✅ Offline guide catalog with search, categories, deep links (`?doc=`), cross-links

## Not implemented (despite appearances)
- ❌ `tools/deploy-app`, `tools/provision-app` — empty directories, zero references
- ❌ Provider table has no repository/domain entity (orphan table)
- ❌ LogEntry table exists but nothing writes/reads it via repositories
- ❌ Secret table exists but has no repository (credentials use Credential table)
- ❌ azure/gcp/hetzner/digitalocean/vultr/linode/ovh/scaleway provider kinds: labels + credential
  schemas only, `DefaultProviderFactory` rejects them
- ❌ The sibling `ansible-playbook-deploy` repo is not consumed by the app
