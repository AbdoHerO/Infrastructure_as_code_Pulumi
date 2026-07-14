# Completion Report

This report records the completed scope of the post-audit phases. It is based on
the source, routes, typed IPC contract, tests and packaging configuration as of
2026-07-14.

## Delivered phases

### Phase 12 — Deployment and operation safety

- SSH host keys are inspected and pinned by SHA-256 fingerprint before a command
  runs.
- Hosts, users, ports, images and shell-derived values are validated; deployment
  steps have cancellation and timeouts and require a real exit status.
- Docker installation no longer pipes a remote script into a privileged shell.
- Interrupted deployment records are reconciled on startup, and direct OCI
  termination polls to a terminal lifecycle state.

### Phase 13 — Regression foundation

- Coverage excludes generated output, release artifacts, declarations and tests.
- The suite now covers 85 cases across domain/services, Pulumi event parsing,
  credential encryption boundaries, OCI signing, deployment validation, settings,
  trusted extensions and real Ed25519/RSA generation/import/passphrases.
- CI runs formatting, lint, strict type checking, tests, build, production audit
  and unpacked installer smoke builds on Windows, macOS and Linux.

### Phase 14 — SSH Keys

The dedicated route generates Ed25519/RSA-3072 keys, imports OpenSSH, PKCS#8 and
traditional PEM keys, validates passphrases, displays OpenSSH public keys and
SHA-256 fingerprints, and protects private-key reveal/delete actions. Encrypted
`Credential` records are the one source of truth, so existing SSH credentials
remain compatible.

### Phase 15 — Containers and Compose

The Containers route uses fingerprint-verified SSH to inventory and control
containers, read logs/stats and deploy Compose projects. It does not expose the
Docker TCP socket. Inputs and project identifiers are validated before any
remote command is built.

### Phase 16 — OCI account operations

- Existing instances can be listed, started, stopped, rebooted and terminated
  with lifecycle polling.
- Paginated account inventory includes instances, VCNs, subnets, internet
  gateways and block volumes.
- Pulumi refresh is exposed as **Refresh / detect drift**. Managed Pulumi stacks
  remain separate from account inventory so the UI does not misrepresent an
  unmanaged resource as locally managed.

CloudForge intentionally advertises only Oracle Cloud. Additional providers are
not shown merely because a credential schema exists.

### Phase 17 — Settings and desktop operations

Reduced motion, default region, destructive confirmation and log retention are
enforced. Logs rotate at 10 MB and old rotations are pruned. Telemetry was
removed instead of presenting a non-functional privacy control. Settings can
create and restore a passphrase-protected portable backup containing a consistent
SQLite snapshot, machine-independent credential envelope and private Pulumi
state; restore first creates a safety backup and re-wraps secrets for the new OS.

### Phase 18 — Release engineering

The app uses a real `electron-updater` state machine with explicit check,
download percentage and restart-to-install actions. Renderer sandboxing,
context isolation and navigation restrictions are enabled. CI and tag-release
workflows build all platforms, audit production dependencies, generate a
CycloneDX SBOM and attest build provenance.

### Phase 19 — Safe extensions

The misleading marketplace/provider mock entries were removed. The route now
contains only trusted declarative extensions bundled with CloudForge. Enabled
contributions affect the application at runtime (the Nord contribution changes
theme tokens), while arbitrary downloaded JavaScript is never executed.

### Phase 20 — Generic VPS configuration

The Ansible route supports key or password SSH credentials, pinned host
fingerprints, persisted reusable VPS targets, fact-based profile readiness,
confirmed prerequisite repair, isolated remote-runtime bootstrap, syntax
validation, post-run service checks, streamed progress and cancellation. Its
trusted catalog contains parameterized Docker, Dockhand,
Portainer, Jenkins and Nginx profiles. The Nginx domain manager owns only its
namespaced files, runs `nginx -t`, rolls back failures, and reloads only
known-good configuration.

The built-in OCI Always Free ARM plan seeds Ubuntu 24.04 on A1 Flex with the
requested 4 OCPUs, 24 GB RAM and 200 GB boot volume. Template application
requires an SSH public key, and OCI stack outputs state the default SSH user.

## Verification snapshot

- Strict TypeScript: all eight workspace projects pass.
- Unit tests: 85/85 pass across 19 test files.
- Production Electron build: main, preload and renderer bundles succeed.
- Security model: Electron sandbox enabled; SSH host fingerprints required;
  secrets stay in the encrypted main-process credential boundary.

## External release requirements

Code cannot manufacture trusted publisher identities. Before publishing a trusted
Windows release, the repository owner must add a Windows signing certificate and
password to repository secrets. The workflow consumes them without committing
them. A semantic tag matching the desktop package version then produces the
installer and update feed used by the Updates module.

Live OCI destructive tests are deliberately not run by the automated suite: they
would create or delete billed account resources. Provider contract tests and
Pulumi test doubles cover behavior without touching the existing HanoutPlusApp
server.
