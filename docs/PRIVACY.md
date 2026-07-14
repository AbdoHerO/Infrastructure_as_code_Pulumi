# Privacy

CloudForge is a local-first desktop application. Its SQLite database, encrypted
credentials, SSH keys, infrastructure plans, logs, and settings remain on the
computer where CloudForge is installed unless the user explicitly exports a
backup or sends data to a configured service.

## Network activity

CloudForge connects only when a user action or enabled setting requires it:

- configured cloud-provider APIs for discovery and infrastructure operations;
- Pulumi providers and the configured Pulumi backend;
- VPS targets over SSH for deployments, containers, Ansible, Nginx, and SSL;
- DNS resolvers for domain verification;
- GitHub Releases for update checks and downloads.

CloudForge does not include advertising or analytics telemetry. Remote providers
and services apply their own privacy and retention policies.

## Sensitive information

Credentials are encrypted at rest through the operating-system-backed security
service described in the [Security guide](SECURITY.md). The **Copy diagnostic
information** action contains version and runtime data only; it excludes
credentials, project records, resource identifiers, host addresses, and logs.

Users control data retention by deleting records in CloudForge or removing the
application data directory. Make a verified encrypted backup before moving or
removing state.
