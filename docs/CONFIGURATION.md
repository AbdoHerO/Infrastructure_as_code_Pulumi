# Configuration & Credentials

Everything CloudForge needs to talk to the outside world — cloud accounts, SSH
keys, API tokens — is entered **inside the app** (Secrets / Settings) and stored
**encrypted** (see [Security](SECURITY.md)). There is **no `.env` file to fill in
to run the app**; the only environment configuration is for developer tooling and
release signing (bottom of this page).

This page lists every credential/setting you may need to provide and **how to
obtain it**.

## Contents

- [Runtime prerequisites](#runtime-prerequisites) — Pulumi CLI, SSH
- [Credentials at a glance](#credentials-at-a-glance)
- [Oracle Cloud (OCI)](#oracle-cloud-oci) ← detailed
- [SSH keys (for deployments)](#ssh-keys-for-deployments) ← detailed
- [Other providers & services](#other-providers--services)
- [In-app settings](#in-app-settings)
- [Developer & release configuration](#developer--release-configuration)

---

## Runtime prerequisites

### Pulumi CLI

Required by the **Infrastructure** module (preview/apply/destroy). You do **not**
need a Pulumi account or `pulumi login` — CloudForge uses a local file backend
and a locally-generated passphrase automatically.

| OS            | Install                                                    |
| ------------- | ---------------------------------------------------------- |
| Windows       | `winget install Pulumi.Pulumi` — or `choco install pulumi` |
| macOS         | `brew install pulumi`                                      |
| Linux / macOS | `curl -fsSL https://get.pulumi.com \| sh`                  |

Verify: `pulumi version`. Restart CloudForge; the Dashboard "IaC engine" row
should read **Pulumi ready**.

### SSH access

Required by **Deployments**, **Containers**, and **Ansible**. You need a Linux host reachable over SSH
and a key pair whose **public** key is installed on the host and whose
**private** key you store in CloudForge (see [SSH keys](#ssh-keys-for-deployments)).
The built-in deployment templates target **Debian/Ubuntu** (they use `apt` +
`sudo`), so use an Ubuntu image and the `ubuntu` login user.

---

## Credentials at a glance

Add these under **Secrets → Add Credential**. Fields marked 🔒 are secret (masked;
revealed only on request). Fields marked _(optional)_ can be left blank.

| Provider (kind)                                      | Fields                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Oracle Cloud** (`oracle`)                          | Tenancy OCID · User OCID · Compartment OCID · Fingerprint · 🔒 API Private Key (PEM) · Region · Profile Name _(optional)_ |
| **AWS** (`aws`)                                      | Access Key ID · 🔒 Secret Access Key · 🔒 Session Token _(optional)_ · Default Region                                     |
| **Azure** (`azure`)                                  | Subscription ID · Tenant ID · Client ID · 🔒 Client Secret                                                                |
| **GitHub** (`github`)                                | 🔒 Personal Access Token                                                                                                  |
| **Jenkins** (`jenkins`)                              | Username · 🔒 API Token · Jenkins URL _(optional when the selected VPS uses port 8080)_                                   |
| **Cloudflare** (`cloudflare`)                        | 🔒 API Token · Account ID _(optional)_ · Default Zone name/ID _(optional)_                                                |
| **OpenAI** (`openai`)                                | 🔒 API Key                                                                                                                |
| **Anthropic** (`anthropic`)                          | 🔒 API Key                                                                                                                |
| **Docker Hub** (`dockerhub`)                         | Username · 🔒 Password / Access Token · Registry _(optional)_                                                             |
| **GitLab** (`gitlab`)                                | 🔒 Access Token                                                                                                           |
| **Deployment Environment File** (`environment-file`) | Filename · 🔒 complete multiline environment content                                                                      |
| **SSH Key** (`ssh`)                                  | 🔒 Private Key (OpenSSH or PEM) · 🔒 Passphrase _(optional)_                                                              |
| **SSH Password** (`ssh-password`)                    | 🔒 Password                                                                                                               |

> **Oracle Cloud** and **AWS** provide complete project attachment,
> Preview/Apply/Destroy and resource discovery workflows. Other provider kinds are
> service integrations or stored extension points. Cloudflare manages DNS/edge
> services, while Jenkins and GitHub credentials power per-VPS application pipelines.

Deployment environment files are application credentials, not cloud-provider
credentials. They are editable, encrypted with the same security model, and may
be attached to any Jenkins pipeline. CloudForge synchronizes only a derived
Jenkins credential ID to the job; plaintext file content never enters pipeline
persistence, Activity history, or logs.

When creating or editing this credential, you can either paste the complete
environment content or select an existing `.env`, `.env.production`, staging, or
development file with the native file picker. Uploaded content is shown in the
editor for review before CloudForge encrypts and saves it. Files are limited to
1 MB and are never copied into the CloudForge installation directory.

---

## Oracle Cloud (OCI)

You need six required values from the OCI Console
(<https://cloud.oracle.com>). Below, each maps to a field in the Add-Credential
form.

### 1. Region

Shown at the top-right of the Console. Use the **region identifier**, e.g.
`eu-frankfurt-1`, `us-ashburn-1`, `uk-london-1`.
→ **Region** field.

### 2. Tenancy OCID

Profile menu (top-right avatar) → **Tenancy: \<name\>** → on the tenancy page copy
**OCID** (starts `ocid1.tenancy.oc1..`).
→ **Tenancy OCID** field.

### 3. User OCID

Profile menu → **My profile** (your user) → copy **OCID**
(starts `ocid1.user.oc1..`).
→ **User OCID** field.

### 4. Compartment OCID

Navigation menu → **Identity & Security → Compartments** → open the compartment
you'll deploy into → copy its **OCID** (`ocid1.compartment.oc1..`). You may use
the **root** compartment, whose OCID equals the **tenancy** OCID.
→ **Compartment OCID** field.

### 5 & 6. API signing key → Fingerprint + Private Key

CloudForge authenticates with an **API signing key** (RSA). Create one:

**Option A — let OCI generate it (easiest)**

1. Profile menu → **My profile** → **Resources → API keys → Add API key**.
2. Choose **Generate API key pair**, **Download private key** (a `.pem` file),
   then **Add**.
3. OCI shows a **Configuration file preview**. Copy the **`fingerprint`** value
   (looks like `aa:bb:cc:dd:...`).
   → **Fingerprint** field.
4. Open the downloaded `.pem` file and paste its **entire** contents (including
   the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines) into
   the **API Private Key (PEM)** field.

**Option B — generate your own key**

```bash
mkdir -p ~/.oci
openssl genrsa -out ~/.oci/oci_api_key.pem 2048
openssl rsa -pubout -in ~/.oci/oci_api_key.pem -out ~/.oci/oci_api_key_public.pem
# fingerprint of the public key:
openssl rsa -pubout -outform DER -in ~/.oci/oci_api_key.pem 2>/dev/null | openssl md5 -c
```

In **API keys → Add API key → Paste public key**, paste
`oci_api_key_public.pem`. Use the printed fingerprint for **Fingerprint**, and
paste `oci_api_key.pem` (the **private** key) into **API Private Key (PEM)**.

### 7. Profile Name _(optional)_

A label only; defaults to `DEFAULT`. Leave blank unless you want to distinguish
multiple OCI configs.

### Required IAM permissions

The user (via its **group**) needs at least **read** access for connection
testing (read user, list regions/shapes/availability domains). In
**Identity & Security → Policies**, a broad example:

```
Allow group <your-group> to read all-resources in tenancy
```

To actually **provision** infrastructure later, grant `manage` on the relevant
resource families in your compartment, e.g.:

```
Allow group <your-group> to manage virtual-network-family in compartment <name>
Allow group <your-group> to manage instance-family        in compartment <name>
Allow group <your-group> to manage volume-family          in compartment <name>
```

### Verify

In CloudForge: **Cloud Providers → Test connection**. Success shows your account
info; **Load regions** / **Load shapes** confirms API access.

---

## SSH keys (for deployments)

The **Deployments** module connects to your host with an SSH **private** key
stored as an `ssh` credential; the matching **public** key must be authorised on
the host.

### 1. Generate a key pair

```bash
# Recommended:
ssh-keygen -t ed25519 -C "cloudforge" -f ~/.ssh/cloudforge
# or RSA if your host requires it:
ssh-keygen -t rsa -b 4096 -C "cloudforge" -f ~/.ssh/cloudforge
```

This creates `~/.ssh/cloudforge` (private) and `~/.ssh/cloudforge.pub` (public).
You may set a passphrase (store it in the credential's **Passphrase** field).

### 2. Authorise the public key on the host

- **At instance creation** (recommended): paste `cloudforge.pub` into your cloud
  provider's "SSH keys" field (OCI/AWS/etc.) when launching the VM.
- **On an existing host**: append the public key to the login user's
  `~/.ssh/authorized_keys`:
  ```bash
  ssh-copy-id -i ~/.ssh/cloudforge.pub ubuntu@<host>
  # or manually append the contents of cloudforge.pub to ~/.ssh/authorized_keys
  ```

### 3. Store the private key in CloudForge

Use **SSH Keys → Import** (or **Secrets → Add Credential → SSH Key**):

- **Private Key (OpenSSH or PEM)** — paste the **entire** contents of
  `~/.ssh/cloudforge` (the private file), including its `-----BEGIN ... PRIVATE
KEY-----` lines. CloudForge accepts OpenSSH, PKCS#8 and traditional PEM keys.
- **Passphrase** _(optional)_ — only if you set one.

### 4. Deploy

In **Deployments**, set **Host**, **Port** (usually 22), **SSH user** (e.g.
`ubuntu`), and select this SSH Key credential.

For a password-only VPS, add **Secrets → SSH Password** instead. All SSH modules
accept either kind, though a key remains recommended for production. Remote
Ansible installation requires `root` or passwordless sudo. See the
[Ansible and Nginx guide](ANSIBLE.md).

The Ansible page can persist the verified destination as a **VPS target**. Its
preflight is read-only; **Prepare VPS** lists and confirms prerequisite packages
before installing the isolated runtime. A current Ready result is required for
each selected profile.

---

## Other providers & services

Brief pointers for the remaining credential kinds:

- **AWS** — IAM → Users → Security credentials → **Create access key**. Provide
  Access Key ID + Secret Access Key, a Default Region, and Session Token only
  for temporary credentials. See the complete [AWS guide](AWS.md).
- **Azure** — create a Service Principal (`az ad sp create-for-rbac`) or in the
  Portal (App registrations). Provide Subscription/Tenant/Client IDs + a Client
  Secret.
- **GitHub** — Settings → Developer settings → **Personal access tokens** →
  generate a (fine-grained or classic) token with the scopes you need.
- **GitLab** — User Settings → **Access Tokens**.
- **Cloudflare** — dashboard → **My Profile → API Tokens → Create Token**.
- **OpenAI** — platform.openai.com → **API keys** (starts `sk-...`).
- **Anthropic** — console.anthropic.com → **API keys** (starts `sk-ant-...`).
- **Docker Hub** — Account Settings → **Security → New Access Token**; use it as
  the Password. Registry defaults to `docker.io`.

---

## In-app settings

Configured under **Settings** (persisted in the local database, not files):

| Setting                     | Section    | Meaning                                        | Default  |
| --------------------------- | ---------- | ---------------------------------------------- | -------- |
| Theme                       | Appearance | `light` / `dark` / `system`                    | `system` |
| Reduced motion              | Appearance | Minimise animations                            | off      |
| Log retention (days)        | General    | How long to keep logs                          | 30       |
| Confirm destructive actions | Deployment | Prompt before destroy                          | on       |
| Default region              | Deployment | Pre-fill new projects                          | empty    |
| Secret storage              | Security   | Read-only: OS keychain vs local key            | auto     |
| Portable backup / restore   | Security   | Database, re-wrapped credentials and IaC state | manual   |

---

## Developer & release configuration

These are **not** needed to run the app; only for tooling/CI.

### Prisma CLI (`packages/database/.env`)

The Prisma **CLI** (`prisma generate`, `db:push`, `db:bootstrap-sql`) reads a
`DATABASE_URL`. A dev default is committed as `.env` / `.env.example`:

```dotenv
DATABASE_URL="file:./dev.db"
```

The **application itself does not use this** — it sets the SQLite path at runtime
from the `userData` directory.

### Code signing / notarization (packaging, CI)

`electron-builder` reads standard environment variables when producing signed
installers (all optional, set in CI — never commit them):

| Variable                                                   | Purpose                                  |
| ---------------------------------------------------------- | ---------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | Code-signing certificate (Windows/macOS) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization                       |

See [Packaging](PACKAGING.md) for the full build flow.

---

## Quick checklist

To exercise the **full** end-to-end flow you'll want:

- [ ] Node ≥ 20.18, pnpm ≥ 9 installed
- [ ] Pulumi CLI installed (`pulumi version` works)
- [ ] An Oracle Cloud credential added & **Test connection** passes
- [ ] An Ubuntu host reachable over SSH
- [ ] An **SSH Key** credential whose public key is authorised on that host

With those in place, follow the walkthrough in
[Getting Started §6](GETTING-STARTED.md#6-using-the-app-end-to-end-walkthrough).

## Cloudflare credential

Create an API Token in **Cloudflare Dashboard → My Profile → API Tokens** and
store it under **Secrets → Cloudflare**. API Token is required; Account ID and a
default zone are optional. See [Cloudflare](CLOUDFLARE.md) for least-privilege
scopes and troubleshooting.

## Jenkins and GitHub credentials

For Jenkins, open the Jenkins user menu → **Security → API Token → Add new
Token**. Store the exact username, the generated token, and the externally
reachable Jenkins URL under **Secrets → Jenkins**. The token is displayed only
once. Global token checkboxes under **Manage Jenkins → Security** configure
policy and are not a replacement for the user's token.

For private GitHub repositories, create a fine-grained token with read access to
the required repository contents and metadata, then store it under **Secrets →
GitHub**. CloudForge installs a derived credential into the isolated Jenkins
folder; it never writes the original token into the Jenkinsfile, pipeline row,
renderer state, Activity history, or logs. See [Jenkins
Pipelines](JENKINS-PIPELINES.md).
