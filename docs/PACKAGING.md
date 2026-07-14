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
  the Credential Manager. Deployment-template and Docker installation commands
  run as shell steps on the target host.

The dashboard surfaces engine availability ("IaC engine: Pulumi ready / not
installed") so users know when a prerequisite is missing.

## Auto-updates

The main process uses `electron-updater` with the GitHub Releases publisher in
`electron-builder.yml`. The Updates page checks the feed, downloads with real
percentage progress, and installs after explicit confirmation. Update checks are
disabled in unpackaged development builds. Publishing must include the generated
`latest*.yml` metadata beside signed artifacts.

## Code signing

`.github/workflows/release.yml` packages all three platforms, creates a CycloneDX
SBOM and build provenance, and supplies signing/notarization values through
repository secrets. Add `WIN_CSC_LINK`/`MAC_CSC_LINK`, certificate passwords,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; private keys are
intentionally never committed.
