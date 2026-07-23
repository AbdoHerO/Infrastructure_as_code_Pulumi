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

## Profiles declare what they need

Each profile declares the host ports its service listens on once installed —
Jenkins on `service_port`, Nginx on 80, Docker on nothing at all because it
listens on a Unix socket and is reached over SSH.

That declaration is what lets the rest of the application see a natively
installed service. Without it, the connectivity check knew every port a Compose
service published and nothing about the Jenkins the same page had just
installed, so it would report a target as fully reachable while its Jenkins was
firewalled off. **VPS Runtime → Connectivity** now merges both.

Nginx declares 80 but deliberately not 443: 443 is needed only when a route
actually terminates TLS, which the runtime plan derives from its own routes.
Declaring it in both places would be a second competing source of truth.

A declaration states that a port _must_ be open for the service to work. Whether
CloudForge opens it is the separate `manage_host_firewall` choice — which is why
a port you firewalled by hand still shows up, correctly, as blocked.

### One firewall implementation

The playbook's firewall task and the profile probe share the shell in
`host-firewall-script.ts` with the certificate manager and the runtime layer. The
task understands ufw, firewalld, nftables and iptables, checks before it changes,
and persists iptables rules that would otherwise vanish on reboot.

nftables is detected before iptables: on a modern distro `iptables` is usually a
compatibility shim over nftables, and driving the shim while reading the real
table is how rules appear to vanish.

## Add a credential and connect

Instances provisioned by CloudForge with a validated SSH key are synchronized
automatically. The target stores the stack public IP, image user, encrypted key
reference, pinned host fingerprint, project, and compute logical name. Every
SSH-based module receives target-change events, so a changed public IP or a
destroyed stack is reflected without duplicating connection records.

For an existing or externally managed VPS:

1. Open **Secrets → Add credential** and choose **SSH Key** (recommended) or
   **SSH Password**.
2. Open **Ansible** in the **Manage** navigation group.
3. Choose **New target**, give it a reusable name, and enter the host/IP, SSH
   port, and login user (`opc`, `ubuntu`, or your user).
4. Select the credential and click **Inspect host**.
5. Compare the displayed `SHA256:…` fingerprint with a trusted value from the
   provider console or server. Continue only when it matches.
6. Click **Save target**. Targets persist locally with their credential
   reference and pinned host identity; secrets remain encrypted. Deleting a
   saved target never deletes or changes the VPS.

Changing the host or port clears the trusted fingerprint.

## Readiness preflight and preparation

Select a profile and click **Check readiness**. The read-only preflight reports
the real OS, architecture, package manager, init system, privilege, Python,
managed Ansible version, memory, disk, DNS/HTTPS, clock, package locks,
firewall/SELinux notes, service-port ownership, and profile-specific conflicts.

Each check is **ready**, **warning**, **repairable**, or **blocked**. A playbook
cannot run until its current profile report is Ready. Changing its target,
credential, profile, or variables invalidates that report.

For repairable prerequisites, **Prepare VPS** displays the exact package plan
and asks for confirmation. It installs CA certificates, curl, a supported
Python/pip/venv stack, the `ss` networking utility, and isolated `ansible-core` at
`/opt/cloudforge/ansible`, then repeats the preflight. Blockers such as missing
passwordless sudo, an unsupported OS, package-manager lock, unreachable HTTPS,
or an unreachable profile package repository/conflicting port require an explicit fix. CloudForge does not silently
remove conflicting packages or weaken security policy.

Before a run, CloudForge executes `ansible-playbook --syntax-check`. After the
run it verifies the expected Docker/container/systemd/Nginx state. The live
terminal shows actual remote stages and output, and an operation can be cancelled.

## Generic profiles

| Profile       | Purpose                                                       | Result                                                                                             |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Docker Engine | Installs official Docker Engine, Buildx, and Compose packages | Docker is enabled; selected users can join the `docker` group                                      |
| Dockhand      | Creates a persistent Compose deployment                       | UI uses the chosen host port; Docker is ensured first                                              |
| Portainer CE  | Creates the official persistent Portainer deployment          | HTTPS UI uses the chosen port (default `9443`); Docker is ensured first                            |
| Jenkins       | Installs Java 21 and Jenkins LTS from the official repository | Jenkins is enabled on the chosen HTTP port; CloudForge prints the URL and initial-password command |
| Nginx         | Installs, validates, starts, and enables native Nginx         | No project domain is embedded in the base profile                                                  |

Profiles are idempotent. Image and port values are variables; there are no
HanoutPlus-specific domains, IPs, repositories, or credentials.

**Refresh states** reads the selected VPS rather than trusting the last local
run. Docker Engine shows the installed version and the actual members of the
remote `docker` group; the **Docker users** field is repopulated from that live
state. Use a comma-separated list such as the SSH account plus `jenkins` when
both need Docker access. Re-running Docker Engine adds the requested users and
updates packages/services in place; it does not remove images, containers, or
volumes.

When Jenkins is selected, **Verify Jenkins** checks that the service is active
and enabled, its configured port is listening, the `jenkins` account belongs to
the Docker group, and it can reach the Docker daemon. **Restart Jenkins** is a
confirmed service action and preserves jobs, plugins, credentials, workspaces,
and build history. These buttons do not trigger application pipelines; use
**Jenkins Pipelines → Run pipeline** for that.

## Route a domain to an application port

Point the domain's DNS record to the VPS and allow TCP port 80 in both the cloud
and host firewall. Then open **Ansible → Nginx domains**:

1. Enter a lowercase domain such as `app.example.com`.
2. Enter an upstream host (normally `127.0.0.1`) and application port.
3. Enable **WebSocket headers** when the application needs upgrades.
4. Click **Validate and apply**.

The action is gated by its own **Check Nginx readiness** result.

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
