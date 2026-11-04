# Docker stacks

The **Docker Stacks** page deploys any Docker Compose stack on a saved server and
publishes it on your domains, with its Cloudflare record, Nginx site and HTTPS
certificate. Your Compose file stays exactly as you wrote it.

## Before you start

The server is saved (Ansible → Targets) and runs **Docker** (with Compose v2) and
**Nginx**. Set them up in VPS Runtime if needed. The stack's images must be on a
registry: only the Compose file and `.env` are uploaded, so `build:` is refused.

## Deploy a stack

1. Open **Docker Stacks**, choose the server and give the stack a name. It becomes
   the Compose project name, shown in Containers and Dockhand.
2. Select **Load from a folder** (it reads `compose.yaml` or `docker-compose.yml`
   and `.env`), or paste them. CloudForge reads the file at once and shows its
   services, what it will create, and anything that needs attention.
3. Under **Domain 1**, choose how the stack is published:
   - **Cloudflare account** and **Domain**: every domain in the account is listed.
   - **Use**: a subdomain (type `files` for `files.example.com`) or the domain
     itself. For a domain not on Cloudflare, choose “Domain not on Cloudflare” and
     type it; you then create the DNS record yourself.
   - **Goes to the service** and **Port inside the container**: where the domain
     leads. Your file does not need to publish this port.
   - **Traffic**: through the Cloudflare proxy, or DNS only.
   - **Largest upload**: what Nginx accepts per request, such as `100m` or `5g`.

   **Add a domain** publishes another port of the stack on another name. **Remove**
   leaves a stack with no public domain.

4. Enter the email for the certificates, select **Deploy stack** and confirm.

The first deploy downloads the images; the **Progress** panel shows each step.

## When a domain is blocked

CloudForge checks the domain as you choose it, and again when you deploy, before
anything reaches the server. The reason is shown when it is already used by:

- a WordPress site, a Docker stack or a Jenkins pipeline of this project;
- an Nginx site on the server, whoever made it;
- a Cloudflare `A`/`AAAA` record pointing to another server, or a `CNAME`.

A domain that could not be checked counts as used. A record that already points to
this server is fine. When no record exists, CloudForge creates it, marked
“Managed by CloudForge”.

## HTTPS

CloudForge picks the certificate that fits how visitors reach the server:

| How visitors arrive                     | Certificate                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Through the Cloudflare proxy            | Cloudflare Origin CA, valid 15 years. Falls back to Let's Encrypt if the token can't do it. |
| DNS only, or a domain not on Cloudflare | Let's Encrypt, renewed automatically                                                        |

For Origin CA the Cloudflare token needs **Zone → SSL and Certificates → Edit**.

CloudForge never changes the Cloudflare SSL mode of a zone, because the other sites
of that domain share it. In **Flexible** mode it does not redirect HTTP to HTTPS on
the server, which would loop forever, and it tells you the traffic between
Cloudflare and the server is not encrypted. Use **Full (strict)** once every site of
the zone has a certificate.

If a certificate cannot be issued yet, the stack still runs and its row shows the
reason. Fix the cause, then select **Redeploy**.

Cloudflare's free certificate covers one level only: `files.example.com`, not
`a.files.example.com`. Use DNS only for deeper names.

## Large uploads

Cloudflare's proxy limits each request to 100 MB on the free plan, whatever **Largest
upload** says. Use **DNS only** for anything that uploads more, such as an S3 API.

## Example: RustFS

RustFS listens on two ports, so it takes two domains:

| Domain              | Service  | Port | Traffic  | Largest upload |
| ------------------- | -------- | ---- | -------- | -------------- |
| `files.example.com` | `rustfs` | 9001 | Proxy    | `100m`         |
| `s3.example.com`    | `rustfs` | 9000 | DNS only | `5g`           |

The console is at `https://files.example.com/rustfs/console/`; its root path answers 403. The S3 API is at `https://s3.example.com`.

## Manage a stack

| Action       | What it does                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Check**    | Reads the containers' state from the server.                                                                       |
| **Edit**     | Changes the Compose file or `.env`, then deploys. A file that Compose refuses leaves the running stack untouched.  |
| **Redeploy** | Downloads the latest images, restarts what changed, and runs DNS, Nginx and HTTPS again.                           |
| **Remove**   | Removes the containers and Nginx sites. Volumes, DNS records and saved files stay, so the same name can come back. |
| **Delete**   | Also deletes the stack's own volumes and files, the DNS records CloudForge created, and the saved files.           |

To change a domain or its port, use **Remove** and deploy again: your data stays.

**External networks and volumes** declared with `external: true` are created when
missing and are never deleted, not even by **Delete**, because other stacks may use
them. Remove them yourself when nothing needs them.

## On the server

```
/opt/cloudforge/stacks/<name>/
  compose.yaml             # your file, unchanged (mode 600)
  compose.cloudforge.yaml  # added by CloudForge: local ports and labels
  .env                     # your variables (mode 600)
  .cloudforge-stack        # marker: only folders with it are changed or deleted
```

Each domain's port is published on `127.0.0.1` only, from 8400 up, on one that is
free on the server. Nginx publishes the domain. The stack shows up in Dockhand under
its name, because Docker labels it as a Compose project.

## Safety

- The Compose file and `.env` are stored encrypted in **Secrets** (“Docker stack ·
  name”). They never appear in a script, a command line or a log: they are uploaded
  over SFTP as owner-only files, and the uploads are deleted at the end, even when a
  step fails.
- A new file is validated with `docker compose config` before it replaces the old
  one, so a broken edit does not touch the running stack.
- A Compose project, a container name or a port that belongs to something else stops
  the deploy before anything changes. A folder without the marker is never touched.
- CloudForge warns when a file publishes a port on all interfaces (Docker bypasses
  the server's firewall), runs privileged, or mounts the Docker socket.
