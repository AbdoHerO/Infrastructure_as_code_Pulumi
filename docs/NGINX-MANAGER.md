# Nginx Manager

The dedicated **Manage → Nginx** module manages one Nginx installation per saved
`VpsTarget`. It reuses the encrypted SSH credential and trusted host fingerprint;
private keys and passwords never cross IPC.

## Safety transaction

Every site, raw-config, delete, and restore operation follows the same remote
transaction:

1. create a timestamped archive under `/var/lib/cloudforge/nginx/backups`;
2. write the proposed configuration;
3. run `nginx -t`;
4. restore the archive automatically if validation fails;
5. reload only after a successful validation; and
6. record the result in Activity history without secrets.

The module provides overview/version/service state, managed sites, visual site
editing, the advanced `nginx.conf` editor, worker/connection status, access and
error logs with search/export, manual validated reload, and backup restore.

CloudForge-owned site files contain an encoded metadata comment so the rich site
model can be reconstructed without duplicate local storage. Existing unmanaged
Nginx configuration is preserved and remains available through the raw editor.

Docker Nginx is detected. Editing a container installation requires its
configuration and logs to be mounted at the standard host locations; otherwise
the dashboard reports the installation but CloudForge refuses to pretend that a
host-side edit changed the container.
