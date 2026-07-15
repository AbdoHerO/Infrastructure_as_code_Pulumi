# Jenkins Pipelines

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
