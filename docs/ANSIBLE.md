# Ansible and Nginx VPS Management

CloudForge's **Ansible** module configures a reachable Linux VPS without requiring
Ansible, WSL, or a Linux control node on the desktop computer. CloudForge opens a
fingerprint-verified SSH session, installs an isolated Ansible runtime at
`/opt/cloudforge/ansible` when necessary, uploads a temporary trusted playbook and
JSON variables, runs it locally on the VPS, streams its real output, and removes
the temporary job directory.

The SSH private key or password is decrypted only in the Electron main process.
It is used for authentication and is never uploaded to the VPS or sent to the
renderer.

## Before you start

- The target must be a Linux VPS reachable by SSH.
- Use `root`, or a user with **passwordless sudo**. CloudForge deliberately does
  not put an SSH/sudo password in a remote file or command line.
- Supported package-manager families are APT (Debian/Ubuntu) and DNF/YUM
  (RHEL-family, including common Oracle Linux images).
- The VPS needs outbound HTTPS access to its distribution repositories and to
  the official repositories used by the selected profile.
- Open required cloud and host firewall ports separately. Installing a service
  does not silently change OCI security lists, UFW, firewalld, or DNS.

## Add a credential and connect

1. Open **Secrets → Add credential** and choose **SSH Key** (recommended) or
   **SSH Password**.
2. Open **Ansible** in the **Manage** navigation group.
3. Enter the host/IP, SSH port, and login user (`opc`, `ubuntu`, or your user).
4. Select the credential and click **Inspect host**.
5. Compare the displayed `SHA256:…` fingerprint with a trusted value from the
   provider console or server. Continue only when it matches.

Changing the host or port clears the trusted fingerprint.

## Check and install the runtime

Click **Check runtime**. **Install Ansible** creates an isolated runtime when it
is absent; running any profile performs the same bootstrap automatically. The
live terminal reports actual remote stages and output instead of inventing a
percentage, and a running operation can be cancelled.

## Generic profiles

| Profile       | Purpose                                                       | Result                                                                  |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Docker Engine | Installs official Docker Engine, Buildx, and Compose packages | Docker is enabled; selected users can join the `docker` group           |
| Dockhand      | Creates a persistent Compose deployment                       | UI uses the chosen host port; Docker is ensured first                   |
| Portainer CE  | Creates the official persistent Portainer deployment          | HTTPS UI uses the chosen port (default `9443`); Docker is ensured first |
| Jenkins       | Installs Java 21 and Jenkins LTS from the official repository | Jenkins is enabled on the chosen HTTP port                              |
| Nginx         | Installs, validates, starts, and enables native Nginx         | No project domain is embedded in the base profile                       |

Profiles are idempotent. Image and port values are variables; there are no
HanoutPlus-specific domains, IPs, repositories, or credentials.

## Route a domain to an application port

Point the domain's DNS record to the VPS and allow TCP port 80 in both the cloud
and host firewall. Then open **Ansible → Nginx domains**:

1. Enter a lowercase domain such as `app.example.com`.
2. Enter an upstream host (normally `127.0.0.1`) and application port.
3. Enable **WebSocket headers** when the application needs upgrades.
4. Click **Validate and apply**.

CloudForge ensures Nginx is installed, writes only
`/etc/nginx/conf.d/cloudforge-<domain>.conf`, runs `nginx -t`, restores the old
file if validation fails, and reloads only after success. **Load managed sites**
lists only CloudForge-owned files, preventing accidental edits to hand-written
sites. Removal deletes the owned file, validates, and reloads.

The current manager configures HTTP reverse proxying. TLS certificate issuance
remains explicit because it requires working DNS, public reachability, an ACME
policy/email choice, and renewal ownership.

## Failure behavior

- A host-key mismatch stops authentication before commands run.
- A missing privilege reports a `sudo -n` error; grant passwordless sudo or use
  `root`, then retry.
- Playbook non-zero exits and stderr appear in live output.
- Temporary job files are removed after completion whenever SSH is available.
- Nginx syntax failure restores the previous site and does not reload a broken
  configuration.
