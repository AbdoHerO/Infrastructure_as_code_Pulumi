# Packaging & Runtime Prerequisites

CloudForge is packaged with **electron-builder** (config in
`apps/desktop/electron-builder.yml`).

## Build a distributable

```bash
pnpm --filter @cloudforge/desktop package        # installer for the current OS
pnpm --filter @cloudforge/desktop package:dir     # unpacked app (faster, for testing)
```

Artifacts are written to `apps/desktop/release/`.

### Targets

| OS      | Target   |
| ------- | -------- |
| Windows | NSIS     |
| macOS   | DMG      |
| Linux   | AppImage |

## Native modules & the Prisma engine

The main/preload/renderer code is bundled by `electron-vite`; the workspace
`@cloudforge/*` packages are bundled into those outputs. Only the externalized
runtime dependencies are shipped from `node_modules` and **unpacked from the
asar** so they can be loaded/spawned at runtime:

- `@prisma/client` + the `.prisma` generated client and query engine binary
- `ssh2` (optional native crypto binding)
- `@pulumi/pulumi`

`npmRebuild: true` rebuilds native modules against the packaged Electron ABI.
If you hit a native-module ABI mismatch during development, run
`npx @electron/rebuild -f -w ssh2`.

Before packaging, generate the Prisma client:

```bash
pnpm --filter @cloudforge/database prisma:generate
```

## Runtime prerequisites (end-user machine)

CloudForge orchestrates external engines that must be installed on the host:

- **Pulumi CLI** — required for the Infrastructure module (preview/apply/destroy).
  The app uses a local file backend under the user data directory and a
  locally-generated passphrase; no Pulumi account is required.
- **SSH access** — the Deployment module connects over SSH using a key stored in
  the Credential Manager. Ansible/Docker steps run as shell commands on the
  target host.

The dashboard surfaces engine availability ("IaC engine: Pulumi ready / not
installed") so users know when a prerequisite is missing.

## Auto-updates

`updates:check` is wired through IPC and the Updates module. Enabling real
auto-updates is a packaging-time concern: add `electron-updater`, publish
releases to a provider (GitHub Releases, S3, …), and call `autoUpdater` from the
main process. The UI contract is already in place.

## Code signing

Signing/notarization is configured through electron-builder environment
variables (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, …) in CI. It is
intentionally not committed.
