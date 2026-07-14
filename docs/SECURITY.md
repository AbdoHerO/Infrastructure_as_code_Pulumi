# Security Model

CloudForge handles cloud credentials and provisions real infrastructure, so
security is a first-class concern. This document describes the defenses in place.

## 1. Electron process hardening

Configured in [`main/window.ts`](../apps/desktop/src/main/window.ts) and
[`main/index.ts`](../apps/desktop/src/main/index.ts):

- **`contextIsolation: true`** — the renderer and preload run in isolated worlds.
- **`nodeIntegration: false`** — the renderer has no Node access.
- **`sandbox: true`** — the renderer and preload use Chromium process sandboxing.
- **`webSecurity: true`**.
- **Strict Content-Security-Policy** — applied to every response _and_ declared
  in the renderer HTML: `default-src 'self'`, `script-src 'self'`, no remote
  origins (only `data:` images/fonts and `ws:` for the dev server).
- **Navigation guards** — `will-navigate` and `setWindowOpenHandler` deny in-app
  navigation and open external links in the OS browser instead.
- **`<webview>` blocked** — `will-attach-webview` is prevented.
- **All permissions denied** — `setPermissionRequestHandler` /
  `setPermissionCheckHandler` refuse camera, microphone, geolocation, etc. The
  renderer needs none.

## 2. The secure IPC bridge

The renderer never sees `ipcRenderer`. The preload exposes exactly one object,
`window.cloudforge`, with:

- `invoke(channel, payload)` — typed request/response returning a `Result`
  envelope.
- `subscribe(channel, listener)` — restricted to an **allow-list** of event
  channels (`IPC_EVENT_CHANNELS`); unknown channels throw.

Because failures cross the boundary as serialized `AppError` data (never thrown
values), the renderer cannot be used to smuggle stack traces or non-serializable
payloads. See [IPC Reference](IPC.md).

## 3. Credential encryption

Secrets are **never stored in plaintext**. Only encrypted `ciphertext` (base64)
is persisted (see [Data Model](DATA-MODEL.md)).

Encryption is done in the main process through the `SecretCipher` port. The
factory [`main/security/secret-cipher.ts`](../apps/desktop/src/main/security/secret-cipher.ts)
picks the strongest available implementation:

1. **`SafeStorageCipher` (preferred)** — Electron `safeStorage`, which is backed
   by the **OS keychain**: Keychain (macOS), DPAPI (Windows), libsecret (Linux).
2. **`AesGcmCipher` (fallback)** — used only when the OS keychain is unavailable.
   AES-256-GCM with a locally-persisted 32-byte key stored `0600` under
   `userData`. Weaker (the key sits on disk) but still never plaintext.

The active mode is surfaced to the user via `security:status` and the Secrets
security banner / Settings.

### Credential lifecycle

- **Create** — the domain validates the fields against the kind's schema; the
  service serializes the secret data to JSON, encrypts it, and stores only the
  ciphertext.
- **List** — returns metadata-only summaries (id, kind, name, timestamps); **no
  secret material**.
- **Reveal** — decrypts on explicit user request and returns the fields (secret
  fields are masked in the UI until the user clicks "Show").
- **Provider/deployment use** — the main process decrypts internally (e.g. to
  build an OCI request signer or an SSH connection) and never sends the plaintext
  back to the renderer. Ansible uses a key/password only for the verified SSH
  connection; it is not uploaded with the temporary playbook.

## 4. Provider request signing

The Oracle provider talks to OCI REST APIs using the **OCI HTTP Signature**
scheme implemented with `node:crypto`
([`oci-signer.ts`](../packages/providers/src/oracle/oci-signer.ts)) — no
third-party SDK in the trust path. The signing logic is unit-tested end-to-end
(sign → verify with a generated key pair).

## 5. Infrastructure engine isolation

Pulumi runs against a **local file backend** under `userData/pulumi/state` with
stack secrets encrypted by a locally-generated passphrase (`0600`). No Pulumi
account or cloud state bucket is required, and Pulumi is never exposed to the UI.

## 6. Audit trail

Notable actions (project create/delete, infrastructure applied/destroyed,
deployment success/failure) are recorded to the `Activity` table and surfaced in
the Logs module — a lightweight, exportable audit log.

## Threat-model notes & responsibilities

- **Local-first**: CloudForge is a single-user desktop app. Data (encrypted
  secrets, SQLite DB, Pulumi state) lives under the OS user profile and inherits
  its file-system permissions.
- **The fallback cipher key is on disk** — prefer running on a platform with an
  OS keychain. The banner tells users which mode is active.
- **Deployment steps run as shell commands** on the target host over SSH; treat
  templates as privileged input. Host fingerprints are pinned, shell-derived
  values are validated, and container image references reject shell metacharacters.
- **Remote Ansible is privilege-bearing** — only trusted built-in profiles run.
  Jobs use localhost mode on the verified VPS, temporary inputs are mode `0600`,
  variables are JSON, and privileged actions require root or `sudo -n`. Managed
  Nginx paths derive from validated domains and syntax failure rolls back.
- **Plugin execution is intentionally out of scope** — the marketplace manages
  trusted declarative contributions only; it does not evaluate third-party code.
- **Code signing / notarization** for distributables is configured via
  electron-builder environment variables in CI (not committed). See
  [Packaging](PACKAGING.md).
