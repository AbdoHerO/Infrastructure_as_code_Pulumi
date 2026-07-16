# Jenkins Pipelines

## Domains and application ports

Use the root domain itself (for example `hanoutplus.ma`) for the main landing page. Use a full
hostname (for example `api.hanoutplus.ma`) for each additional application. CloudForge creates or
updates the Cloudflare record and configures Nginx on the selected VPS to route that hostname.

The application port is the port exposed **on the VPS**, not the public web port. For example, a
container started with `-p 3000:3000` is reached through VPS port `3000`, so enter `3000`.
Nginx continues to own public ports 80 and 443 and proxies requests to `127.0.0.1:3000`. Every
simultaneously running application must use a different VPS host port, while all domains may share
the same public IP and ports 80/443.

CloudForge rejects a Jenkins credential whose URL points to `localhost` when a remote VPS target is
selected. This prevents a pipeline intended for a VPS from being created or executed by a Jenkins
server on the desktop computer. A repository Jenkinsfile may choose a Jenkins agent, so production
Jenkinsfiles should also target the VPS controller or an explicitly configured remote agent.

CloudForge manages Jenkins as a service installed on an existing VPS target. It does not
duplicate VPS or SSH records. Every target receives an isolated folder named
`cloudforge-<target>-<id>`, and every application becomes a Pipeline job inside that folder.

## Prerequisites

1. Use **Ansible → Jenkins** to install Jenkins on the target VPS.
2. Complete the Jenkins setup wizard and install the suggested plugins. The Pipeline, Git,
   Folders, Credentials, and Plain Credentials plugins are required.
3. In Jenkins, open **User → Security → API Token**, create a token, and copy it once.
4. In **Secrets**, create a **Jenkins** credential containing the Jenkins username, API token,
   and optional full URL (for example `http://203.0.113.10:8080`).
5. For private repositories, create a **GitHub** credential in Secrets. CloudForge installs it
   into the target's Jenkins folder; after credential creation, the token is never returned to
   the renderer or written to pipeline persistence/logs.

## Create a pipeline

Open **Jenkins Pipelines**, select the VPS and Jenkins credential, then choose either:

- **Jenkinsfile from Git** — repository, branch, Jenkinsfile path, and optional GitHub token.
- **Inline pipeline steps** — generic Groovy steps for a small pipeline managed by CloudForge.

For an SCM pipeline, explicitly select **Public repository** or **Private repository**. Private
mode requires an encrypted GitHub credential created under **Secrets → GitHub**. Its personal
access token grants repository access; the separate Branch / ref field selects `main`, another
branch, a tag ref, or a branch pattern. Tokens are intentionally never entered directly into the
pipeline form.

Add any number of typed build parameters (`string`, `boolean`, `choice`, or `password`) and
environment values. Parameter names use environment-variable syntax such as `IMAGE_TAG` or
`DEPLOY_ENV`. Saving is idempotent: an existing job is updated in place.

## Domain automation

Enable **Configure application domain**, provide `app.example.com` and the host port exposed by
the application. CloudForge then reuses the selected/default Cloudflare credential to create or
update the DNS origin record and applies a validated Nginx reverse proxy to `127.0.0.1:<port>`.
Issue the first certificate from **SSL & Domains** after the application is reachable; scheduled
renewal remains owned by that module.

## Run and observe

Select a saved pipeline, fill its parameters, and choose **Run pipeline**. CloudForge queues the
build through Jenkins' crumb-protected API and refreshes job status every 15 seconds. Creation,
updates, runs, failures, domain setup, and deletion are recorded in Activity history without
tokens or secret values.

## Troubleshooting

- **401/403** — create a Jenkins API token for the exact username stored in Secrets.
- **404 creating folders/jobs** — install Pipeline, Folders, Git, and Credentials plugins.
- **Connection timeout** — open the Jenkins port in OCI and the VPS firewall, or use an HTTPS
  Nginx domain as the Jenkins URL.
- **Git authentication failure** — select a GitHub credential with repository read permission.
- **Domain setup failed** — verify the default Cloudflare credential/zone and that Nginx is
  running on the target.
