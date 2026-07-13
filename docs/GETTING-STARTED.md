# Getting Started — Run, Test & Use CloudForge

This guide walks you through installing, running, testing and **using**
CloudForge end to end. For the exact credentials/keys you'll need and where to
get them, see the companion [Configuration & Credentials](CONFIGURATION.md)
guide.

---

## 1. Prerequisites

| Requirement                          | Needed for                                        | Notes                                                                             |
| ------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Node.js ≥ 20.18**                  | Everything                                        | `node -v`                                                                         |
| **pnpm ≥ 9**                         | Everything                                        | `npm i -g pnpm` then `pnpm -v`                                                    |
| **Git**                              | Cloning                                           |                                                                                   |
| **Pulumi CLI**                       | The Infrastructure module (preview/apply/destroy) | Optional until you provision infra. [Install steps](CONFIGURATION.md#pulumi-cli). |
| **A reachable Linux host + SSH key** | The Deployments module                            | Optional until you deploy.                                                        |
| **An Oracle Cloud account**          | Real cloud provisioning / connection testing      | Optional; the app runs and most modules work without it.                          |

> You can run the app and explore Projects, Templates, Settings, Secrets, Logs,
> Plugins, etc. **without any cloud account**. Cloud accounts/CLIs are only
> needed for the live provisioning and deployment features.

---

## 2. Install

```bash
git clone <your-repo-url> cloudforge
cd cloudforge

pnpm install                                          # install the workspace
pnpm --filter @cloudforge/database prisma:generate    # generate the Prisma client
```

The `prisma:generate` step is required once (and again whenever the database
schema changes) — it produces the typed Prisma client the app builds against.

---

## 3. Run in development

```bash
pnpm desktop
```

This launches the Electron app with hot-reload (electron-vite). A window opens
on the **Dashboard**. On first run the app:

- creates its SQLite database at `cloudforge.db` in the OS user-data directory,
- initialises a local Pulumi home + file backend,
- generates a local encryption key/passphrase (used only if the OS keychain is
  unavailable).

**Where is my data?** (the `userData` directory)

| OS      | Path                                                                       |
| ------- | -------------------------------------------------------------------------- |
| Windows | `%APPDATA%\CloudForge\` (e.g. `C:\Users\<you>\AppData\Roaming\CloudForge`) |
| macOS   | `~/Library/Application Support/CloudForge/`                                |
| Linux   | `~/.config/CloudForge/`                                                    |

It contains `cloudforge.db` (SQLite), `secret.key`, and a `pulumi/` folder
(state + passphrase). Deleting the folder resets the app.

---

## 4. Test & verify

All commands run from the repo root.

```bash
pnpm typecheck        # type-check the whole workspace (strict TS)
pnpm lint             # ESLint 9 (type-checked)
pnpm test             # all unit tests (Vitest, per package)
pnpm test:coverage    # all tests from root + a single V8 coverage report
pnpm build            # build every package and the desktop app
pnpm format           # Prettier
```

These four are the project's **quality gates** — `typecheck`, `lint`, `test`,
`build` should all be green. Run a single package with
`pnpm --filter @cloudforge/<pkg> test`.

Manual/interactive verification: run `pnpm desktop` and exercise the flow in
section 6.

---

## 5. Build a distributable (optional)

```bash
pnpm --filter @cloudforge/desktop package        # installer for your OS
pnpm --filter @cloudforge/desktop package:dir     # unpacked app (faster to test)
```

Artifacts land in `apps/desktop/release/`. See [Packaging](PACKAGING.md) for
native-module and code-signing details.

---

## 6. Using the app (end-to-end walkthrough)

The typical journey, module by module. Each step notes what you need.

### Step 1 — Store a credential (Secrets)

1. Go to **Secrets** → **Add Credential**.
2. Pick a provider (e.g. _Oracle Cloud_), give it a name, and fill the fields.
   See [Configuration & Credentials](CONFIGURATION.md) for exactly what each
   field is and how to obtain it.
3. Save. The secret is encrypted (OS keychain when available) — the banner at the
   top tells you which encryption mode is active.

> Add an **SSH Key** credential too (kind: _SSH Key_) if you plan to deploy — it
> stores the private key you'll use to reach your hosts.

### Step 2 — Test the provider (Cloud Providers)

1. Go to **Cloud Providers** — it lists your provider credentials.
2. Click **Test connection**. On success you'll see your account info.
3. Click **Load regions** / **Load shapes** to confirm API access.

If this fails, your credential fields or IAM permissions are the usual cause —
recheck them against [Configuration & Credentials](CONFIGURATION.md).

### Step 3 — Create a project (Projects)

1. **Projects** → **New Project**.
2. Enter a name, environment (`development`/`staging`/`production`) and region.
3. **Link a cloud provider credential** (the one from Step 2). This is required:
   Preview and Apply authenticate against that account, and the engine refuses to
   run without it.
4. Create. A project is the container for one managed infrastructure.

### Step 4 — Compose & provision infrastructure (Infrastructure)

1. **Infrastructure** → select your project.
2. Either **Add resource** (network → subnet → firewall → compute → volume) and
   edit fields, **or** start from a blueprint in **Templates → Apply to project**.
3. **Save plan**, then **Preview** (a dry run) and watch the live engine log.
4. **Apply** to provision. **Destroy** tears it down.

Apply creates **real Oracle Cloud resources** — a VCN per network (with an
internet gateway and route table for public subnets), security lists from your
firewall rules, subnets, compute **Instances** launched from the newest matching
platform image, and block **Volumes** — all visible in the Oracle Cloud Console.
Instance public/private IPs are surfaced as stack outputs after Apply.

> This requires the **Pulumi CLI** installed (the Dashboard's "IaC engine" row
> shows _Pulumi ready_ when it's detected) and the project's provider credential
> linked (Step 3). On the first Apply, Pulumi downloads the Oracle resource
> plugin, so it needs internet access and may take a minute.
>
> **Free-tier tip:** the built-in templates default to the `VM.Standard.E4.Flex`
> shape, which is **not** Always-Free-eligible. To stay within the free tier,
> edit the compute resource's shape to `VM.Standard.E2.1.Micro` (x86) or
> `VM.Standard.A1.Flex` (Arm) before applying.

### Step 5 — Deploy an application (Deployments)

1. **Deployments** → choose your project, a **template** (Docker Host, Node,
   WordPress, Ollama, …), the **host** IP/port, the **SSH user**, and the **SSH
   key** credential from Step 1. Optionally a container image.
2. **Deploy**. Watch per-step output stream live. History is recorded with a
   status badge.

> Requires SSH reachability to the host and a correct SSH-key credential.

### Step 6 — Observe (Dashboard & Logs)

- **Dashboard** — stat cards, a live activity timeline, a projects-by-environment
  chart, and runtime/engine status.
- **Logs** — a searchable, filterable, **exportable** (JSON) activity feed of
  everything that happened (projects, infra, deployments).

### Other modules

- **Settings** — theme, telemetry, log retention, default region, confirm-destructive.
- **Plugin Marketplace** — install/enable extensions (providers, templates,
  widgets, themes).
- **Updates** — current version + update status.
- **Templates** — browse infrastructure & deployment blueprints.

---

## 7. Troubleshooting

| Symptom                                            | Likely cause / fix                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prisma` / Prisma client type errors               | Run `pnpm --filter @cloudforge/database prisma:generate`.                                                                                                                                                                            |
| Dashboard shows "IaC engine: Pulumi not installed" | Install the [Pulumi CLI](CONFIGURATION.md#pulumi-cli) and restart the app.                                                                                                                                                           |
| "Test connection" fails on Oracle                  | Re-check tenancy/user/compartment OCIDs, fingerprint, region and the **full PEM** private key; ensure the API key is added to your OCI user and your IAM policy allows read. See [Configuration](CONFIGURATION.md#oracle-cloud-oci). |
| Deployment can't connect                           | Verify host/port/user, that the host allows your key, and that the **SSH Key** credential holds the matching private key (+ passphrase if any).                                                                                      |
| Secrets banner says "Local encrypted key"          | The OS keychain isn't available; secrets use an on-disk AES key (weaker but never plaintext). Prefer a machine with a keychain.                                                                                                      |
| Reset everything                                   | Quit the app and delete the `userData` directory (section 3).                                                                                                                                                                        |
| Port/HMR weirdness in dev                          | Fully quit Electron and re-run `pnpm desktop`.                                                                                                                                                                                       |

---

## 8. Command cheat-sheet

```bash
pnpm install                                         # install
pnpm --filter @cloudforge/database prisma:generate   # generate Prisma client
pnpm desktop                                         # run (dev)
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # full gate
pnpm test:coverage                                   # coverage report
pnpm --filter @cloudforge/desktop package            # build installer
```

Next: [Configuration & Credentials](CONFIGURATION.md).
