# CloudOps — Architecture Decision

| | |
|---|---|
| **Purpose** | Answer the repository/module architecture question posed by `CLOUDOPS-HANDOFF.md`, from evidence in the CloudForge codebase |
| **Status** | **D-22 ACCEPTED by the owner on 2026-10-07** (§4). D-13 and the remaining items stay as marked. No CloudOps code exists. No CloudForge file was modified to produce this. |
| **Date** | 2026-10-07 |
| **CloudForge inspected** | v0.4.1, branch `main`, working tree at `73bec9d`, read-only |
| **Companion** | `CLOUDOPS-HANDOFF.md` (the specification this answers) |

### Correction notice — server sizing (2026-10-07)

**The candidate server is 2 OCPUs and 12 GB RAM, Ubuntu 24.04, 200 GB boot volume — not 1 OCPU /
6 GB / 50 GB.** Verified by the owner against the live Infrastructure plan and stack outputs
(`abdoheroPublicIp 84.8.217.33`, `abdoheroSshUser ubuntu`, shape `VM.Standard.A1.Flex` with OCPUs 2
and Memory 12, boot volume 200 GB, ingress 22/80/443/8080/3000).

Where the figure came from, so it stops circulating:

| Source | Says | Status |
|---|---|---|
| `docs/FIRST-INSTANCE.md` §"HanoutPlusApp created on this workstation" | 1 OCPU, 6 GB, Oracle Linux 9.7 ARM, 50 GB, `opc@51.170.132.115`, instance `hanoutplus-server` | **Stale.** CloudForge product documentation describing an earlier instance. Not corrected by this review (see §20) |
| `CLOUDOPS-HANDOFF.md` §2, §19 q12, §20 risk 6, §22 | 1 OCPU, 6 GB, 50 GB | **Superseded by this notice.** The handoff read the stale doc |
| This document | 2 OCPU, 12 GB, 200 GB | Current |

The `1 OCPU · 6 GB base` caption under CloudForge's shape selector is the Flex shape's **per-OCPU
base unit**, not the configured instance — a UI label worth not misreading.

**What this changes:** risk 6 (sizing) drops from a blocker to a planning input, and the existing
server becomes a credible CloudOps host rather than a marginal one (§19, §20). **What it does not
change:** the repository and technology recommendation, which does not depend on server size at all.

### Status vocabulary

Carried forward from the handoff, with one addition:

- **ACCEPTED** — the owner explicitly asked for or approved it.
- **PROPOSED** — recommended by the handoff investigation; not approved.
- **PENDING** — cannot be decided until something else happens.
- **REJECTED** — the owner ruled it out.
- **RECOMMENDED** — *new in this document.* A recommendation from this architecture review,
  supported by evidence from the CloudForge codebase, awaiting owner approval. **Nothing here is
  ACCEPTED.**

### Why this file is beside the handoff rather than in `docs/`

`docs/` is CloudForge's curated product documentation: `docs/README.md` is a table of contents for
it, and `apps/desktop/src/renderer/src/features/documentation/documentation-catalog.ts` imports
those files **by name** into the application's in-app Documentation page. A CloudOps decision record
is not CloudForge product documentation and does not belong in that index. Say the word and I will
move it.

---

## 1. Executive recommendation

> **Build CloudOps as a separate repository, with a small, versioned, CloudOps-owned contract
> surface. Keep the proposed technology: Laravel panel, Go agent.**
>
> This is **Option A**, carrying the contract discipline of Option D. Options B, C and E are
> rejected, each for a concrete reason found in the code rather than a preference.

Three measurements decided it.

**1. The reuse prize is smaller than it looks, and in PHP/Go it is zero.**

| Candidate | Non-test lines | Realizable in Laravel/Go |
|---|---|---|
| `@cloudforge/shared` (Result, AppError, Brand, Uuid) | **431** | 0 |
| `@cloudforge/ui` (React design system) | 924 | 0 |
| Cloudflare adapter (`service-providers`) | 938 | 0 |
| Everything else (`core` 13,300, `deployment` 5,572, `database`, `providers`, `pulumi`) | — | 0 — CloudForge's own domain |

The entire shared kernel is **431 lines with zero dependencies**. "Reuse `@cloudforge/shared`" means
reusing a `Result` type, an error hierarchy, and a UUID brand — a day of work to rewrite, and
idiomatically *wrong* to port: Go has `(T, error)` and PHP has exceptions and typed returns.

**2. A monorepo's value is compile-time sharing and one toolchain. With Laravel + Go there is
neither.** `turbo.json` defines `build`, `typecheck`, `lint`, `test` — every one of them `tsc`,
`eslint` or `vitest`. `pnpm-workspace.yaml` globs `apps/*` and `packages/*`. A Composer project and
a Go module participate in none of it except through wrapper `package.json` files that exist only to
satisfy the orchestrator. The benefit is zero; the costs are immediate and listed in §7.

**3. The costs are concrete, not hypothetical.** `.github/workflows/release.yml` triggers on
`tags: v*` and then asserts the tag equals `apps/desktop/package.json`'s version:

```yaml
on: { push: { tags: ['v*'] } }
```
```powershell
if ($tag -ne "v$version") { throw "Tag $tag does not match apps/desktop/package.json version $version" }
```

A CloudOps `v1.0.0` tag in the same repository fires the Windows release job and fails it. And
`scripts/set-release-version.mjs` writes one version into both the root and desktop manifests — the
repository has a single-product version identity baked into its release tooling.

---

## 2. What CloudOps should be

A **separate product**: a self-hosted application hosting control plane for native PHP and Laravel
applications, consisting of a web panel and a root-level server agent, deployed to Linux servers,
running continuously, independent of CloudForge at runtime (D-18, PROPOSED → **supported by this
review**).

It is a *different kind of thing* from CloudForge in every dimension that architecture cares about:

| | CloudForge | CloudOps |
|---|---|---|
| Deployable | Signed Windows NSIS installer + auto-update feed | Linux daemon (ARM64/x86_64) + web application |
| Runtime | On demand, on one laptop | Always on, on production servers |
| Users | One, local | One now; a team later, over the network |
| Attack surface | Local desktop; no listener (verified: no `node:http`, no `.listen(`, no server anywhere in the repo) | Internet-facing panel, public webhook endpoint, **root** agent |
| Holds | Cloud provider credentials, SSH private keys, broad Cloudflare token | No cloud credentials, no SSH keys; narrow Cloudflare token, MySQL admin |
| Release cadence | Tagged desktop releases with an update feed users consume | Server deploys, as often as wanted |

These are not two modules of one product. They are **two products that meet on a server**.

## 3. What CloudForge should remain responsible for

Unchanged from handoff §6 (D-16, PROPOSED). This review found nothing to move: VPS provisioning and
Pulumi state, cloud networking, both firewalls, OS packages and Ansible profiles, Docker and
Compose and Docker networks, Jenkins, container applications and their reverse-proxy routes,
`/etc/nginx/**` and `nginx.conf`, `/opt/cloudforge/**` and `/var/lib/cloudforge/**`, Cloudflare zone
settings, and DNS records marked `Managed by CloudForge`.

**CloudForge needs no change at all for CloudOps V1.** Every integration point is a convention on the
server, not an interface in the code. That is a property worth protecting: it means CloudOps can be
built, deployed and iterated without a single commit to a released product with an auto-update feed.

## 4. Recommended repository architecture

> ### D-22 — **ACCEPTED** (owner, 2026-10-07)
>
> **AMENDED 2026-10-07 (same day):** the owner has chosen to provision a **new, dedicated, clean
> VPS** for CloudOps instead of sharing `abdohero`. The repository decision (Option A) is unchanged
> and unaffected. **The co-tenancy acceptance below is therefore withdrawn** — it no longer applies,
> because there are no co-tenants. The thirteen isolation conditions remain in force on their own
> merits: they are good design for a hosting platform regardless of what else shares the box, and
> condition 13 (design for a move to a dedicated VPS) is now satisfied from day one rather than
> deferred. The audit of `abdohero` keeps its value as the reference for what CloudForge leaves on a
> server and for the integration surface.
>
> ~~**Option A: CloudOps is a separate repository. CloudOps V1 will initially run on the existing
> `abdohero` VPS**~~ (`VM.Standard.A1.Flex`, 2 OCPUs, 12 GB RAM, Ubuntu 24.04, 200 GB boot volume,
> `84.8.217.33`).
>
> **The co-tenancy risk is explicitly accepted by the owner** for V1, in exchange for simplicity and
> cost efficiency. CloudOps and the existing Docker/Jenkins applications share this server. This is
> an accepted trade, **not** a claim that the server is isolated or risk-free.
>
> The acceptance is conditional on CloudOps being designed with strong isolation. The owner's
> conditions, recorded verbatim in intent:
>
> | # | Condition | Where it is specified |
> |---|---|---|
> | 1 | Per-application Linux users | D-04 ACCEPTED; startup plan §21 |
> | 2 | Per-application directories | D-15; startup plan §21 |
> | 3 | Strict filesystem permissions | Startup plan §21 |
> | 4 | Agent reachable only through a Unix socket, never a public API | D-03 ACCEPTED; startup plan §12 |
> | 5 | Panel must not expose arbitrary root shell execution | R-02 REJECTED; startup plan §12 |
> | 6 | Root operations only through a fixed allowlisted agent API | D-03 ACCEPTED; startup plan §12 |
> | 7 | CloudOps must not access CloudForge credentials | §13; startup plan §10 |
> | 8 | CloudOps must not modify CloudForge-owned Docker/Jenkins resources | §16; startup plan §21 (deny list) |
> | 9 | CloudOps must not automatically modify existing applications | D-24 ACCEPTED, R-04 REJECTED |
> | 10 | Existing Docker/Jenkins applications stay under CloudForge/Jenkins ownership | D-24 ACCEPTED |
> | 11 | CloudOps Nginx configuration isolated from CloudForge's | D-17; §14; startup plan §13 |
> | 12 | CloudOps databases and users clearly namespaced | D-11; startup plan §15 |
> | 13 | Design for a future move to a dedicated VPS | Startup plan §20, §22; §17 |
>
> Condition 13 has a concrete consequence that shapes V1: **nothing may assume this server.** No
> hardcoded host, no "the server" singular in the data model, no state that only exists because the
> panel and the agent happen to share a machine. The panel talks to the agent over a transport that
> is a Unix socket today and mutual TLS later (§17), and the application record carries a server
> identity from the first migration even while there is only one.

The accepted layout:

```text
infrastructure_as_code/            CloudForge — untouched
CloudOps/                          CloudOps — its own git repository
├── panel/                         Laravel application
├── agent/                         Go module
├── contracts/                     ← the integration surface, versioned
│   ├── manifest.schema.json         what the agent writes for others to read
│   ├── prerequisites.schema.json    what CloudOps requires of a host
│   └── ownership.md                 markers, prefixes, paths, deny lists
├── scripts/vps-audit.sh
└── docs/
```

Two repositories, side by side in one editor workspace. The owner already works this way; the
handoff itself notes (§18, point 6) that a single workspace needs no repository merge.

### Why `contracts/` lives in the CloudOps repository, not a third one

The handoff's Option D offers three homes for contracts: a published package, a third repository, or
vendored schemas. For **one developer**, a third repository and a private registry are both pure
overhead. More importantly, the ownership is not symmetric:

| Contract | Written by | Read by | Owner |
|---|---|---|---|
| Manifest (`/var/lib/cloudops/manifest.json`) | CloudOps agent | CloudForge, humans | **CloudOps** |
| Host prerequisites | — (a requirement) | Whoever provisions (CloudForge profile or a human) | **CloudOps** |
| `Managed by CloudForge`, `io.cloudforge.*`, `/opt/cloudforge/**` | CloudForge | CloudOps (deny list) | **CloudForge** (already exists, already documented) |

Two of the three are CloudOps' to define. The third already exists in CloudForge and is documented
in `docs/VPS-RUNTIME.md` and `docs/CLOUDFLARE.md`. So: CloudOps declares its contracts as JSON
Schema plus a specification; CloudForge vendors a copy **only if and when** it starts reading the
manifest (track F4). Today it reads nothing, so today nothing is needed on the CloudForge side.

A published npm package would be the wrong artifact regardless: a Laravel application cannot consume
one.

## 5. Recommended technology stack

**RECOMMENDED: keep D-13 as proposed — Laravel panel, Go agent.** Both survive scrutiny, and this
review found a new argument for Go that the handoff did not state.

### Go agent — and the circularity argument

The handoff's rationale (static binary, small surface, good Unix-socket and TLS support) is sound.
There is a stronger one:

> **CloudOps installs, upgrades and manages Node and PHP for the applications it hosts. An agent
> written in Node or PHP would depend on a runtime that CloudOps itself changes.**

Upgrading Node to build an application could break the agent that performs the upgrade. A static Go
binary has no such relationship with anything on the host. For a root daemon whose failure mode is
"the hosting platform cannot repair itself", that is close to decisive.

### Laravel panel

The owner works in Laravel daily, and the panel needs authentication, 2FA, queues, a scheduler,
encryption, validation and an admin UI — all of which Laravel ships. For a single developer, that
dominates.

**The TypeScript alternative, costed honestly:** a TS panel plus TS agent could reuse
`@cloudforge/shared` (431 lines), `@cloudforge/ui` (924), and the Cloudflare adapter (938) —
about **2,300 lines**, of which only the Cloudflare adapter is non-trivial. In exchange it gives up
the owner's primary framework and introduces the agent circularity above. The trade is bad.

One genuine finding in favour of TypeScript, recorded for completeness: `@cloudforge/core` has **no
`node:` imports and no Electron imports** — it is pure, portable TypeScript that would run on a
server. And the Cloudflare adapter imports only *types* from `core` (`import type`), so its runtime
coupling is zero. A TypeScript CloudOps could genuinely consume them. It still should not, for the
reasons above — but the option is real rather than imaginary, and if the owner ever wants to
revisit D-13, this is the evidence.

### Panel database (D-27, PENDING)

**RECOMMENDED: MySQL/MariaDB**, the same server the panel manages, in its own database with its own
user. Rationale: it is the conventional Laravel choice, the owner knows it, and the server has it
anyway under D-11. The handoff's SQLite argument (independence from the managed MySQL) is real but
thin — if MySQL is down, the applications are down too, so panel independence buys little. **Open
for the owner.**

## 6. Why this is better than the alternatives

Each rejection rests on something found in the code.

**Against B (restructure into `cloudforge/` + `cloudops/`)** — it requires moving a *released*
product. `pnpm-workspace.yaml`, `turbo.json`, `electron.vite.config.ts` aliases,
`electron-builder.yml`, `scripts/stage-packaged-runtime.cjs`, `scripts/verify-packaged-runtime.cjs`,
both CI workflows and `scripts/set-release-version.mjs` all encode today's paths. CloudForge ships a
signed installer with an auto-update feed; a packaging mistake reaches users. **Churn against a
live release pipeline, for zero compile-time benefit.**

**Against C (`apps/cloudops-panel`, `apps/cloudops-agent`)** — this is the tempting one, and it
fails on three specifics:

1. **Nothing enforces the boundary.** `eslint.config.js` has no `no-restricted-imports`, no
   boundaries plugin, no import rules at all. Today nothing would stop
   `apps/cloudops-panel` importing `@cloudforge/core` and tying an internet-facing product to
   CloudForge's domain model. That enforcement would have to be built and maintained.
2. **The release workflow breaks** (§1). Fixing it means path-filtering and tag-prefixing a release
   pipeline that currently works.
3. **CI secret surface.** `release.yml` consumes `WIN_CSC_LINK` and `CSC_KEY_PASSWORD`. GitHub
   Actions secrets are repository-scoped. Putting an internet-facing product's workflows in the same
   repository as a code-signing certificate is a risk that environments can narrow but not remove,
   and that costs nothing to avoid by not doing it.

And the payoff C is supposed to deliver — shared packages — is **zero lines** with Laravel and Go.

**Against E (hosting UI inside CloudForge, no web panel)** — it contradicts the one requirement the
owner stated most clearly: a hosting-panel experience. No browser, no phone, no second person, and
management only while a Windows laptop is open and the project unlocked. It also makes CloudForge a
*client of a server API*, which is an entirely new architecture for an application that today has no
client-server relationship with anything, and it adds a large new domain to a 20,788-line desktop
app that already carries 23 feature modules.

E's one real strength — **no internet-facing admin panel** — is worth keeping, and §11 keeps it as a
deployment rule rather than an architecture.

**Against A-without-contracts** — the handoff correctly notes the risk: contracts drift when nothing
compiles them together. §4 answers it with versioned schemas and contract tests on both sides.

## 7. Detailed comparison of all alternatives

Scored against this codebase, not in the abstract.

| Dimension | A (separate) | B (two tops) | C (monorepo apps) | D (A + shared contracts) | E (agent + CF UI) |
|---|---|---|---|---|---|
| Architecture clarity | High | Medium | Medium | High | Medium |
| Coupling | Lowest | Medium | **Highest** (unenforced imports) | Low | Highest (CF → agent client) |
| Security separation | High | Medium | **Low** (shared CI secrets) | High | High (no panel) but CF grows |
| Deployment independence | Full | Partial | Partial | Full | UI tied to CF releases |
| CI/CD | Two simple pipelines | Must split by path and tag | Must split by path and tag | Two simple pipelines | CF pipeline grows |
| Versioning | Independent semver | Needs tag namespacing | Needs tag namespacing | Independent + contract semver | Agent independent, UI not |
| Release lifecycle | Untouched | **Rebuilt** | Modified | Untouched | Modified |
| Developer experience | Two folders, one workspace | One clone, mixed toolchains | One clone, mixed toolchains | Two folders, one workspace | One UI codebase |
| Testing | Independent + contract tests | One long CI | Turbo affected-only (TS only) | Independent + contract tests | Agent on VMs |
| **Reuse of CloudForge code** | **0 lines** (Laravel/Go) | 0 | 0 | 0 | ~all UI, if TS |
| Future multi-server | Clean | Neutral | Neutral | Clean | Natural but desktop-bound |
| Monolith risk | None | Medium | Medium–High | Low | **High** |
| Duplicated functionality | Medium (concepts) | Low | Low | Medium–low | Lowest |
| Effect on CF release pipeline | **None** | Rebuild | Modify | **None** | Modify |
| Effect on CF users | **None** | Risk during restructure | Low | New module, bigger installer |
| Independent evolution | **Highest** | Medium | Medium | High | Low |
| Matches the desired experience | Yes | Yes | Yes | Yes | **No** |

## 8. Exact CloudForge components that can be reused

Not "we can reuse CloudForge". Component by component, with the verdict the brief asked for.

| Component | Lines | Verdict | Note |
|---|---|---|---|
| `@cloudforge/shared` — `Result`, `AppError`, `Brand`, `Uuid` | 431 | **Concept only** | Zero dependencies and genuinely portable, but `Result` is un-idiomatic in both Go and PHP. Take the *discipline* (expected failures are values, errors carry a stable code and context), not the code |
| `@cloudforge/ui` — React + Tailwind design system | 924 | **Should NOT be shared** | A Laravel panel uses Blade/Livewire. Even with Inertia+React, the reusable part is the HSL token set in `tailwind-preset.ts`, not the components |
| Cloudflare adapter (`service-providers`) | 938 | **Concept only** (Laravel/Go); *reusable with adaptation* if TS | Imports only **types** from `core`, so runtime coupling is zero. The valuable 100 lines are the Origin CA flow and the `Managed by CloudForge` comment-marker ownership check |
| `cloudflare-dns-automation-service.ts` — the three-outcome ownership rule | — | **Reusable directly as a rule** | "Marked as mine or absent → act; unmarked pointing elsewhere → refuse and name both addresses; unmarked already pointing here → leave entirely alone, and do not claim it." CloudOps must implement exactly this, inverted for its own marker |
| Nginx validate-and-rollback transaction | — | **Concept only — and partly an ANTI-pattern** | Copy: backup → write → `nginx -t` → restore on failure → reload only on success. **Do not copy** the whole-directory scope: `find /etc/nginx -mindepth 1 -delete` is precisely why CloudOps must live outside `/etc/nginx` and write per-file atomically (D-17) |
| `nginx-site-file.ts` — naming and markers | 89 | **Concept only** | Imports `core` types. The idea — one canonical path per domain, a parseable metadata marker, clean up the legacy name in the same transaction — is what transfers |
| `host-firewall-script.ts` | 437 | **Should NOT be shared** | Zero imports and genuinely portable, but firewalls are CloudForge-owned (§8 of the handoff). CloudOps never writes a firewall rule. Worth reading once for the lesson: detect nftables **before** iptables, because `iptables` is usually a shim |
| `vps-preflight.ts` — OS/arch detection, readiness grading | — | **Concept only** | The grading vocabulary (ready / warning / repairable / blocked) is a good model for the CloudOps prerequisites check |
| Ansible playbooks (`ansible-playbooks.ts`) | — | **Reusable with adaptation — by CloudForge, not CloudOps** | If D-19 says CloudForge installs the hosting stack, the new profile is a *CloudForge* change (track F1) that extends this file. It is not CloudOps consuming CloudForge |
| Runtime plan / drift / ownership model | ~3,000 | **Concept only** | CloudOps needs a far simpler model. The transferable ideas: a resource you did not create is never drift; `unknown` is a first-class state; adoption is a record, not an operation |
| Preview → fingerprinted single-use token → apply | — | **Concept only** | Worth copying for any CloudOps destructive operation |
| SSH layer (`ssh-deployer`, `ssh2`) | — | **Should NOT be shared** | The agent is *local* to its server. It has no SSH client role at all |
| `database` (Prisma/SQLite), `providers`, `pulumi` | — | **Should NOT be shared** | CloudForge-specific by construction |
| IPC contract and registry | — | **Should NOT be shared** | Electron-only |
| Secret cipher (`safeStorage`/AES-GCM) | — | **Should NOT be shared** | DPAPI is a Windows desktop mechanism. A Linux server needs a different design |
| Testing utilities | — | **Nothing substantial** | Shared `sh -n` resolution for generated shell is a good idea to copy, not import |

**Summary: zero lines of code transfer. Roughly a dozen hard-won design rules do.** That is the
honest answer, and it is the single strongest argument against a monorepo — you would pay full
structural cost for sharing that does not exist.

## 9. Components that must remain isolated

Never shared, never jointly owned, whatever the layout:

- **Cloud provider credentials** (Oracle, AWS) — never leave CloudForge, never reach a server.
- **SSH private keys and pinned host fingerprints** — CloudForge only.
- **CloudForge's broad Cloudflare token** — CloudOps gets its own narrow token (D-21).
- **Pulumi state** — CloudForge only.
- **The Electron secret cipher** — desktop mechanism; no server analogue.
- **`@cloudforge/core`'s domain model** — projects, credentials, infrastructure plans, runtime plans.
  CloudOps importing this would couple an internet-facing product to a desktop app's domain.
- **CloudForge's Prisma schema and SQLite database.**
- **The CloudOps agent's root operation catalogue** — must never be reachable from CloudForge code.
- **The panel's session and 2FA state.**

## 10. CloudForge ↔ CloudOps integration model

**RECOMMENDED: integrate on the server, through conventions — not through code, and not through an
API.**

```text
CloudForge (desktop, on demand)              CloudOps (server, always on)
        │                                              │
        │  provisions, installs, opens ports           │  hosts applications
        ▼                                              ▼
┌───────────────────────── the VPS ──────────────────────────┐
│  CloudForge-owned                 CloudOps-owned            │
│  /etc/nginx/**                    /etc/cloudops/**          │
│  /opt/cloudforge/**               /srv/cloudops/**          │
│  /var/lib/cloudforge/**           /var/lib/cloudops/**      │
│  Docker, Jenkins, firewalls       PHP-FPM, co_* databases    │
│                                                             │
│  integration surface:                                       │
│   • ownership markers (both directions)                     │
│   • /etc/nginx/conf.d/zz-cloudops.conf  (one include file)   │
│   • /var/lib/cloudops/manifest.json     (read-only, no secrets) │
│   • host prerequisites contract                             │
└─────────────────────────────────────────────────────────────┘
```

Four properties make this work:

1. **No runtime dependency either way** (D-18). CloudForge can be uninstalled and CloudOps keeps
   deploying, renewing and backing up. This is forced by the facts, not chosen: CloudForge's SSL
   renewal and Cloudflare sync are `setInterval` timers in `apps/desktop/src/main/container.ts` that
   stop when the window closes.
2. **No API is required**, so CloudForge needs no new attack surface. Verified: the repository
   contains no HTTP server, no listener, nothing to extend.
3. **Both sides can rebuild their view from the server**, from names, paths, labels and markers — so
   neither depends on the other's database.
4. **The manifest is one-way and read-only.** CloudOps writes; anyone may read. It contains no
   secrets.

### Suggested CloudForge track (all optional, all later, none required for V1)

| ID | Change | Value | Status |
|---|---|---|---|
| F1 | Ansible profile installing the hosting stack (PHP-FPM, MySQL, Composer, Node, agent) | Makes D-19 "CloudForge installs it" real | **PENDING D-19** |
| F2 | Warn before replace/destroy when a CloudOps manifest exists on the target | Mitigates risk 2 (server replacement destroys CloudOps data) | RECOMMENDED |
| F3 | Shared `flock /run/lock/nginx-config.lock` around Nginx mutations | Removes the concurrent-edit window (risk 16) | RECOMMENDED |
| F4 | Read-only "Hosting" panel in CloudForge showing the CloudOps manifest over existing SSH | One place that lists every application on the server | RECOMMENDED |
| F5 | Pass an enrollment token when installing the agent | Enables multi-server (§17) | Later |

F4 deserves a note: it recovers most of Option E's appeal — CloudForge becomes a *viewer* of CloudOps
— at a fraction of the coupling, because reading a JSON file over SSH is not an API client.

## 11. Security boundary

```text
Internet
   │  (only two public surfaces)
   ├── the panel        → Cloudflare Access / IP allowlist / SSH tunnel  + mandatory TOTP (D-26 PENDING)
   └── POST /webhook    → HMAC-verified, replay-rejected, rate-limited
                              │
                    Panel (user `cloudops`, no sudo, no shell)
                              │  Unix socket, root:cloudops 0660, peer credentials verified
                    Agent (root) — allowlisted typed operations only, never a shell (R-02 REJECTED)
                              │
                    CloudOps-owned resources only; explicit deny list of CloudForge paths
```

**RECOMMENDED additions from this review:**

- **Repository separation is part of the security boundary, not just tidiness.** CloudForge's release
  workflow holds Windows code-signing secrets, which are repository-scoped in GitHub Actions. An
  internet-facing product's CI should not share that scope.
- **Carry Option E's best idea forward:** do not expose the panel to the open internet. Cloudflare
  Access or an SSH tunnel is a materially different threat model from a public admin login, and it
  costs nothing to adopt at the start. **Recommend Cloudflare Access** — the zone is already managed,
  and it keeps browser and phone access, which an SSH tunnel does not.
- **Never put cloud provider credentials on a server**, and never give the panel SSH keys.

## 12. Deployment boundary

| | CloudForge | CloudOps panel | CloudOps agent |
|---|---|---|---|
| Artifact | Signed NSIS installer + `latest.yml` | Laravel release (git + Composer) | Static binary per architecture |
| Target | Windows desktop | The server | Every managed server |
| Trigger | `v*` tag → GitHub Release | Panel repository release | Agent release, pinned per server |
| Update | `electron-updater` feed | Deliberate | Deliberate, version-pinned |
| Rollback | Reinstall previous | Release symlink | Replace binary, restart unit |

Three independent lifecycles. Nothing in the recommended architecture couples them. Note the agent
and panel are **separately versioned** on purpose: upgrading a root daemon on a production server
should never be a side effect of a UI change.

## 13. Data and secret boundary

| Secret | Lives in | Never in |
|---|---|---|
| Oracle/AWS credentials | CloudForge (DPAPI/safeStorage) | Any server, the panel, the agent |
| SSH private keys, pinned fingerprints | CloudForge | The panel, the agent |
| Pulumi state + passphrase | CloudForge `userData` | Anywhere else |
| CloudForge's Cloudflare token | CloudForge | CloudOps |
| CloudOps' narrow Cloudflare token | Agent config, root 0600 | The panel, any repository |
| MySQL admin (`cloudops_admin`) | Agent config | The panel |
| Application DB credentials, env vars | Panel DB (encrypted) + `shared/.env` 0600 | Logs, manifest, audit entries, API responses |
| Git deploy keys | The application's `.ssh/`, 0600 | Anywhere else; only the public half is displayed |
| Webhook secrets | Panel DB (encrypted) | Logs |

The manifest carries **no secrets** — that is what makes it safe to read from CloudForge or by hand.
The handoff's canary test (inject a known secret, assert it appears in no output) is the right
enforcement and should be in CI from the first commit.

## 14. Nginx ownership model

Confirmed by reading the code; the handoff's analysis is accurate and the risk is real.

`packages/deployment/src/nginx-exec-script.ts` rolls back with
`find /etc/nginx -mindepth 1 -delete` followed by extracting a tar archive of the whole directory.
The directory-emptying is itself a deliberate fix (removing the directory would strand a container's
bind mount on a deleted inode). But the consequence stands: **any file inside `/etc/nginx` that
postdates the archive disappears on a rollback or a manual restore, silently.**

**RECOMMENDED: D-17 as proposed.**

```text
/etc/nginx/conf.d/zz-cloudops.conf     ← CloudOps' ONLY file inside CloudForge's territory
    include /etc/cloudops/nginx/sites/*.conf;

/etc/cloudops/nginx/sites/<slug>.conf  ← outside every CloudForge archive
/etc/cloudops/nginx/snippets/
```

Plus, from this review:

- The agent must **verify the include file exists on every operation and health check**, and be able
  to restore it with owner confirmation. A CloudForge restore older than the CloudOps installation is
  the one realistic way every CloudOps site stops being served at once.
- The `zz-` prefix is load-bearing: `conf.d/*.conf` loads alphabetically, so CloudOps' include lands
  last and cannot shadow a CloudForge site.
- Hostname conflict detection must scan **every** `server_name` on the host, including CloudForge's,
  and refuse a hostname already served elsewhere.
- F3 (shared lock) would close the concurrent-edit window entirely and is cheap on both sides.

## 15. Cloudflare ownership model

**RECOMMENDED: D-21 as proposed.** Separate narrow token (Zone Read, DNS Read, SSL and Certificates
Edit, restricted to the relevant zones). CloudOps never touches zone settings.

Two things this review confirms matter:

1. **CloudForge sets zones to Full (strict) and Always Use HTTPS** after issuing an Origin CA
   certificate. A CloudOps hostname on a proxied record **must** have a valid origin certificate
   before it goes live, or Cloudflare returns 526. Certificate-before-live is not an optimisation; it
   is a correctness requirement created by the other product.
2. **CloudForge's DNS ownership rule is already exactly right** and CloudOps should mirror it
   inverted. From `cloudflare-dns-automation-service.ts`: a record marked as mine or absent → act; an
   unmarked record pointing elsewhere → refuse, naming both addresses; an unmarked record already
   pointing here → leave alone and **do not claim it**. That last branch is the subtle one, and the
   reason is good: stamping your marker on someone else's record lets a later action withdraw a
   record you never created.

## 16. Docker / Jenkins ownership model

**Unchanged: CloudForge owns both** (D-24, ACCEPTED). CloudOps requires no Docker (D-01, ACCEPTED).

- Existing container applications — HanoutPlus and the three stacks deployed in this workspace
  (`lp-tifaw`, `interview-hub`, `sm-erp`) — stay with CloudForge and Jenkins.
- CloudOps must not read their `.env`, touch their containers or databases, claim their hostnames, or
  modify their routes.
- CloudOps may **display** their hostnames read-only so one screen lists everything on the server.
- D-02 (no Reverse-proxy application type in CloudOps) is **supported**: CloudForge's Jenkins domain
  automation already owns `HOST_PORT` and reasserts it on every read. A second writer for the same
  Nginx upstream is exactly the two-owner failure the ownership rule exists to prevent.
- Migration of a container application to native CloudOps hosting stays out of scope, per-application
  and explicit if ever done (D-24).

## 17. Future multi-server architecture

The recommended layout reaches it without restructuring:

```text
CloudOps panel (one)
   ├── mTLS ──→ agent on server A   (CloudForge-provisioned)
   ├── mTLS ──→ agent on server B
   └── mTLS ──→ agent on server C
```

- The agent's operation catalogue is already specified as transport-independent, so the Unix socket
  becomes one transport among two rather than a thing to replace.
- Enrollment: CloudForge's hosting profile (F1) installs the agent with a one-time token (F5); the
  agent exchanges it for a client certificate. CloudForge already distributes secrets to servers
  safely — this is the same shape as pushing a credential into a Jenkins folder.
- **This is where separate repositories pay off again.** Multi-server is a CloudOps-only evolution:
  panel, agent protocol, enrollment. In a monorepo every such change drags the desktop app's CI
  through it.

## 18. Migration and implementation strategy

No CloudOps code exists, so there is nothing to migrate — only an order of work.

| Phase | Work | Gate |
|---|---|---|
| 0 | ~~Owner approves D-22~~ **DONE 2026-10-07.** D-13 still to confirm | **Owner** |
| 1 | Run the read-only VPS audit on the chosen server | Closes D-11, D-14, D-15, D-20, PHP versions, sizing |
| 2 | Decide D-19 (who installs the hosting stack) and the target server | **Owner** |
| 3 | Create the CloudOps repository: `panel/`, `agent/`, `contracts/`; CI; no server contact | — |
| 4 | Agent skeleton: socket, peer credentials, audit log, prerequisites check, manifest writer. **No privileged operation yet** | Tested on a disposable VM |
| 5 | First privileged operations: user, directory layout, PHP-FPM pool, Nginx site + include file, `nginx -t`, reload | Disposable VM only |
| 6 | Panel: auth + 2FA, application CRUD, agent client, deployment history | — |
| 7 | Deployment pipeline: releases, shared state, health checks, atomic switch, rollback | — |
| 8 | Certificates, databases, workers, cron | — |
| 9 | Backups with off-server copies **and a restore test** (D-23) | Restore proven |
| 10 | First real application on the production server, alongside the existing stacks | **Owner** |

**Rule for every phase: a disposable VM before the production server.** Risk 13 is not theoretical —
that server runs HanoutPlus and three stacks deployed in this workspace.

## 19. Risks and mitigations

The handoff's 17 risks stand. This review adds four, all specific to the architecture decision.

| # | Risk | Mitigation |
|---|---|---|
| 18 | **Contract drift** — nothing compiles the two sides together, so the manifest format and the marker conventions diverge silently | Versioned JSON Schema in `contracts/` with a `format` field; contract tests on both sides; CloudForge vendors a copy only when it starts reading (F4) |
| 19 | **Ownership rules live in prose, not code** — "CloudOps never writes CloudForge paths" is a sentence until something enforces it | An explicit deny list *in the agent*, tested: every operation's path arguments are checked against `/etc/nginx` (except the one include file), `/opt/cloudforge`, `/var/lib/cloudforge`, and Docker/Jenkins resources. A test asserts each denial |
| 20 | **Two repositories drift in a one-developer workflow** — CloudOps assumes CloudForge behaviour that later changes | `CLOUDOPS-HANDOFF.md` and this document pin the behaviours relied on, with file paths. Re-verify them when CloudForge changes its Nginx, Cloudflare or runtime code |
| 21 | **Nothing stops a future monorepo merge from being done casually** — the decision's rationale is lost and someone "simplifies" by merging | This document, kept beside the handoff, with the measurements (§1, §8) that produced the answer |

### Re-scored from the handoff

**Risk 6 (small VPS) is downgraded.** The handoff scored it on 1 OCPU / 6 GB. The server is
2 OCPU / 12 GB with a 200 GB volume, and `free -h` on it reported 11 GiB total with **9.3 GiB
available** while all four existing stacks were running. Composer and npm builds, a PHP-FPM master
per version and a MySQL server fit comfortably in that. It becomes a planning input — cap concurrent
builds, use `ondemand` PHP-FPM pools — rather than a reason to buy a second server.

Two things survive the correction and are worth keeping in view:

- **Disk, not memory, is now the thing to watch.** Release-based deployments keep N releases per
  application, each with its own `vendor/` and built assets, alongside Docker images for four
  stacks and Qdrant's storage. 200 GB is ample today and is the figure to track per application.
- **Co-tenancy is a judgement, not a capacity question.** A root agent and an internet-facing panel
  on the same box as HanoutPlus and three live stacks means one compromise reaches everything. That
  argument for a second server is unaffected by the sizing correction, and is now the *only*
  argument for one.

The most under-weighted existing risk is **#2, server replacement**. Pulumi replaces an Oracle
instance when immutable metadata such as the SSH key changes — CloudForge's own
`docs/FIRST-INSTANCE.md` warns that a replacement can change the public IP and lose the boot volume.
A CloudOps server holding every application, database and the panel is a far larger loss than
anything CloudForge risks today. **Off-server backups (D-23) should be in V1, and F2 should warn
before any replace or destroy.** This review raises D-23 from PROPOSED to **strongly recommended**.

## 20. Decisions that still require your approval

### Decided by this review (RECOMMENDED — your approval turns them ACCEPTED)

| ID | Recommendation |
|---|---|
| ~~**D-22**~~ | **ACCEPTED 2026-10-07** — moved out of this table; see the accepted wording in §4 |
| **D-13** | **Keep Laravel panel + Go agent.** Reinforced by the agent circularity argument (§5) |
| D-02 | Supported: no Reverse-proxy type in CloudOps |
| D-16, D-17, D-18, D-21 | Supported as proposed |
| D-23 | Supported, and **raised in priority** — V1, with a proven restore |
| D-26 | **Cloudflare Access** recommended over IP allowlist or SSH tunnel |
| D-27 | **MySQL/MariaDB** recommended for the panel database — weakly held, see §5 |

### Still yours alone

| ID | Question |
|---|---|
| **D-19** | Who installs PHP, MySQL, Composer, Node and the agent — a CloudForge Ansible profile (F1), or documented manual setup? This is the next decision after the audit |
| D-11 | MySQL native on the host vs container — needs the audit |
| D-14, D-15, D-20 | Edge ownership, base directory, OS support — need the audit |
| ~~—~~ | ~~**Which server?**~~ **ACCEPTED 2026-10-07: the existing `abdohero` VPS.** Co-tenancy risk explicitly accepted by the owner in exchange for simplicity and cost; see §4 for the isolation requirements that acceptance carries |
| — | Supported PHP versions |
| F1–F5 | Which CloudForge changes you accept, and when. **None is required for V1** |

### Not decided here, deliberately

Nothing in the handoff moved from PROPOSED or PENDING to ACCEPTED by this document. The VPS audit has
not been run. No server was contacted. No CloudForge file was modified.

---

## The question you asked

> **Designing this for the next 3–5 years, would you keep CloudOps separate, put it in the CloudForge
> monorepo, or something else — and why?**

**Separate repository. Not reluctantly, and not "it depends".**

The reason is not tidiness. It is that **the two products diverge over that horizon rather than
converge.** CloudForge is a single-user Windows tool for building infrastructure; its natural future
is more providers, better previews, a stronger runtime model. CloudOps is a multi-tenant-ish,
always-on, internet-facing hosting platform; its natural future is more servers, more application
types, more people, a public surface that must be defended continuously. Shared repository, shared
CI, shared dependency graph and shared release machinery would give them a **shared fate** that
neither benefits from — and shared fate is what you cannot undo cheaply later.

The decisive evidence is that **the sharing a monorepo exists to enable does not exist here.** I
measured it: the entire reusable surface is 431 lines of `Result`/`AppError`, a 924-line React
design system a Laravel panel will not use, and a 938-line Cloudflare client — and with Laravel and
Go, the realizable figure is **zero lines**. What actually transfers is about a dozen design rules,
and rules travel in documents. One of the most valuable — CloudForge's Nginx rollback that empties
the whole directory — transfers as a thing CloudOps must *not* do.

Against that zero sits a concrete bill: a release workflow that fires on `v*` and asserts the tag
matches the desktop version; a version script that writes one version for the whole repository; a
CI that lints and tests everything on every change; no import-boundary enforcement to stop an
internet-facing product reaching into a desktop app's domain model; and Windows code-signing secrets
scoped to the repository. You would be restructuring a product that ships a signed installer with an
auto-update feed, in exchange for nothing.

The place these products genuinely meet is the **server** — a file in `conf.d`, a marker in a DNS
comment, a path prefix, a manifest. That integration surface is a handful of conventions, and
conventions are versioned with schemas, not with a build graph.

What I would protect above all: **CloudForge needs no change for CloudOps V1.** Not one commit. A
new product that can be designed, built, deployed and thrown away without touching a working,
released application is in the strongest possible position — and it is a position you only get by
keeping them apart.

One thing I would borrow from the option I rejected: Option E was right that an internet-facing
admin panel is the largest new risk here. Put the panel behind Cloudflare Access from day one, and
build F4 later so CloudForge can *read* the manifest and show you every application on the server
from the desktop. You get E's safety and E's single pane of glass without E's coupling.

---

**Nothing has been implemented. No CloudForge file was modified. Awaiting your review.**
