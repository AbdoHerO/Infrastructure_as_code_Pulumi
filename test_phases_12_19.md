The new phases turn CloudForge from a basic infrastructure editor into a safer server-management application.

## Phase 12 — Safer deployments

Purpose: prevent connecting to the wrong server or leaving deployments stuck.

You benefit from:

- SSH host fingerprint verification.
- Deployment cancellation.
- Timeouts for frozen SSH commands.
- Better failure reporting.
- OCI deletion waits until Oracle confirms termination.

How to use it:

1. Open **Deployments**.
2. Enter the server IP, SSH user and key.
3. Click **Inspect host**.
4. Verify/trust the fingerprint.
5. Start the deployment.
6. Follow each step or click **Cancel**.

## Phase 13 — Automated testing

Purpose: prevent future changes from silently breaking existing features.

You benefit indirectly:

- 62 automated tests protect projects, credentials, SSH keys, deployments, Pulumi and settings.
- TypeScript and lint checks detect invalid code.
- CI tests changes automatically.

Developer commands:

```powershell
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

## Phase 14 — SSH Keys

Purpose: manage server-access keys from a dedicated interface instead of manually creating files.

How to use it:

1. Open **SSH Keys**.
2. Generate an Ed25519 or RSA key, or import an existing private key.
3. Copy the public key into a new OCI instance.
4. Select the stored key in **Deployments** or **Containers**.
5. View its SHA-256 fingerprint.
6. Reveal the private key only through the protected action.

The key is encrypted in CloudForge’s credential storage.

## Phase 15 — Containers and Compose

Purpose: manage Docker workloads on any SSH-accessible VPS.

How to use it:

1. Open **Containers**.
2. Enter the server IP, SSH username and port.
3. Select an SSH key.
4. Inspect and trust the host fingerprint.
5. Connect to the server.

You can then:

- List containers.
- Start, stop and restart containers.
- Remove containers with confirmation.
- Read container logs.
- Inspect CPU and memory statistics.
- Deploy a Docker Compose YAML project.

This works through SSH; you do not need to expose the Docker API publicly.

## Phase 16 — Oracle Cloud management

Purpose: manage both CloudForge-created infrastructure and existing OCI resources.

In **Cloud Providers**, you can:

- Load existing OCI instances.
- Start, stop or reboot them.
- Permanently terminate an instance.
- View VCNs, subnets, internet gateways and block volumes.
- Load available regions and compute shapes.

In **Infrastructure**, use **Refresh / detect drift** to compare Pulumi’s state with Oracle’s real state.

Important distinction:

- **Managed Cloud Stacks** are resources created and tracked by CloudForge/Pulumi. Destroy the stack to remove its resources in dependency order.
- **Cloud Providers** shows account resources, including resources created outside CloudForge.

## Phase 17 — Settings, recovery and backup

Purpose: make the desktop application safer and easier to recover.

You benefit from:

- Destructive-operation confirmations.
- Default region applied to new projects.
- Reduced-motion accessibility.
- Automatic log rotation and retention.
- Startup recovery for interrupted deployment records.
- Database, encryption-key and Pulumi-state backup/restore.

Use **Settings → Security** to create a backup before important infrastructure operations.

Keep the backup protected because it includes the local encryption key and infrastructure state.

## Phase 18 — Professional releases and updates

Purpose: package and distribute CloudForge like a real desktop application.

You benefit from:

- **Updates** can check, download and install packaged releases.
- Real download percentage.
- Electron sandbox protection.
- Windows, macOS and Linux build workflows.
- Dependency security audits.
- SBOM and build-provenance generation.
- Branded CloudForge application icon.

The update system becomes operational after signed releases are published to the configured GitHub repository. Windows and macOS signing certificates must still be supplied by the repository owner.

## Phase 19 — Safe extensions

Purpose: allow CloudForge capabilities to be extended without executing unknown downloaded JavaScript.

Currently:

1. Open **Built-in Extensions**.
2. Install the Nord theme.
3. Enable it.
4. The application’s colors change immediately.
5. Disable or uninstall it to restore the standard theme.

Fake AWS, Hetzner and template entries were removed because credential forms alone do not constitute real provider support.

## Recommended workflow for your server

For `HanoutPlusApp`, the useful sequence is:

1. **Projects** → select `HanoutPlusApp`.
2. **Infrastructure** → Preview, Apply or Refresh.
3. **SSH Keys** → select/manage the server key.
4. **Deployments** → verify the host and install the Docker Host template.
5. **Containers** → deploy and manage your application with Compose.
6. **Cloud Providers** → start, stop, reboot or inspect the OCI instance.
7. **Managed Cloud Stacks** → destroy the complete stack when you truly want to remove everything.
8. **Settings → Security** → create regular backups.

The investigated Ansible repository is not integrated yet. It should first be made generic and have its exposed keys rotated; afterward, it can become another deployment option alongside the current SSH templates.