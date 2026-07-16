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

## Containerised Nginx

A containerised Nginx is detected, and — since the runtime refactor — can be
edited, validated and reloaded like a native one. Validation runs
`docker exec <container> nginx -t` and the reload runs
`docker exec <container> nginx -s reload`, because `systemctl reload nginx` on a
host whose Nginx is a container reloads nothing.

Editing still requires the container to share the host's `/etc/nginx`, and
CloudForge proves that rather than assuming it: before any change, it writes a
dotfile on the host and checks the container can see it. A container with its own
baked-in `/etc/nginx` would otherwise validate a config with nothing to do with
the one just written, and report success — which looks exactly like it worked.
If the probe fails, the change is refused and the dashboard says why.

A native binary wins when both exist, which is what the status probe already
reports. Every existing native install therefore behaves exactly as it did
before.

### Rollback and the bind mount

Every mutation is wrapped in a backup-validate-rollback transaction. The rollback
empties `/etc/nginx` in place and extracts the archive over it; it does **not**
remove the directory. Removing it would strand the container's bind mount on a
deleted inode, so the restore would land in a new directory the container cannot
see — and it would carry on serving the config that had just been rolled back,
until someone restarted it and found out. Emptying in place keeps the inode, so
the container sees the restore at once. The rollback is itself re-validated.
