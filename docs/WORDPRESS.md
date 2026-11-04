# WordPress sites

The **WordPress** page deploys a complete WordPress site on one of your saved
servers and publishes it on your domain:

- the latest official images: `wordpress:latest` (PHP and Apache), `mariadb:lts`
  for the database, and `wordpress:cli` for setup and updates;
- one Docker Compose project per site, named `cloudforge-wp-<domain>`
  (`blog.example.com` → `cloudforge-wp-blog-example-com`), so the site shows up
  as one stack in **Containers** and in Dockhand;
- Cloudflare DNS (optional), an Nginx site and a free Let’s Encrypt certificate,
  through the same services as the Nginx and SSL & Domains pages;
- WordPress fully installed: site title, admin account and site URL, with PHP
  limits for real use (64 MB uploads, 256 MB memory).

## Before you start

- The server is saved (Ansible → Targets) and runs **Docker** (with Compose v2)
  and **Nginx**. Set them up in VPS Runtime if needed.
- For HTTPS, the domain must point to the server. With a domain on Cloudflare,
  CloudForge creates the record; otherwise create the `A` record yourself
  before deploying.

## Deploy a site

1. Open **WordPress** and choose the server and your **Cloudflare account**.
   The **Domain** list shows every domain in that account: pick one, then
   either **New subdomain** (type `blog` for `blog.example.com`) or **The
   domain itself**. For a domain that is not on Cloudflare, choose “Domain not
   on Cloudflare” and type it.
2. CloudForge checks the domain as you choose it. It is blocked, with the
   reason, when it is already used by:
   - another WordPress site or a Jenkins pipeline of this project;
   - an Nginx site on the server (CloudForge-managed or not);
   - a Cloudflare `A`/`AAAA` record pointing to another server, or a `CNAME`.

   A record that already points to this server is fine. The same check runs
   again when you deploy, so a taken domain is never changed.

3. Fill in the site title, admin user name and admin email.
4. Leave **Admin password** empty to get a strong generated one, or type your
   own (at least 12 characters). Leave **Local port** empty: CloudForge picks a
   free one from 8300.
5. Keep **HTTPS** on, then select **Deploy WordPress** and confirm.

The first deploy downloads the images and takes a few minutes; the **Progress**
panel shows each step. At the end, CloudForge shows the site address, the admin
page, the user name and the password once, with **Copy** buttons. The password
stays available in **Secrets**, under `WordPress · <domain>`.

If HTTPS could not be issued yet (usually DNS that has not propagated), the site
still runs and the row shows a warning. Fix the cause, then select **Redeploy**.

Deploying a domain again after **Remove** reuses the passwords kept in Secrets
(and the admin account WordPress was installed with), so the site comes back
with its content and the same login.

## Manage a site

| Action       | What it does                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Check**    | Reads the containers' state and the WordPress version from the server.                                                     |
| **Update**   | Downloads the latest images, restarts the site (a few seconds) and updates WordPress core. Content and plugins are kept.   |
| **Redeploy** | Runs every step again with the same passwords: containers, DNS, Nginx, HTTPS. Use it after a failed step.                  |
| **Remove**   | Removes the containers and the Nginx site; the database, uploads and passwords stay, so deploying again restores the site. |
| **Delete**   | Removes everything: containers, database, files, Nginx site and saved passwords. It cannot be undone.                      |

WordPress also installs its own security releases automatically. Themes and
plugins are managed in the WordPress admin as usual.

## On the server

```
/opt/cloudforge/wordpress/cloudforge-wp-<domain>/
  compose.yaml           # no password inside
  php.ini                # upload and memory limits
  .env                   # DB_PASSWORD, DB_ROOT_PASSWORD (mode 600)
  .cloudforge-wordpress  # marker: only folders with it are changed or deleted
```

- WordPress listens on `127.0.0.1:<port>` only; Nginx publishes the domain.
- Data lives in two Docker volumes, `<project>_db-data` and `<project>_wp-data`.
- Behind Nginx and Cloudflare, WordPress trusts `X-Forwarded-Proto` and
  `CF-Visitor`, so HTTPS works with Cloudflare Full, Full (strict) and Flexible
  without redirect loops.

## Security

- Passwords never appear in a script or a command line. They are uploaded over
  SFTP as owner-only files, moved into `.env` (mode 600) or read from stdin by
  WordPress, and the uploads are deleted at the end, even when a step fails.
- The admin password is set inside WordPress from stdin, never through WP-CLI's
  `--prompt`, which prints the value it reads.
- A redeploy keeps the database passwords the volume was created with, and never
  resets an admin password changed later inside WordPress.
- A port that something else listens on stops the deploy before anything starts,
  and a domain whose Nginx site CloudForge does not manage is refused.
- `admin`, `administrator` and similar admin user names are refused.
