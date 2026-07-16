# Jenkins Pipelines

CloudForge manages Jenkins on an existing `VpsTarget`. It creates one isolated
folder per VPS and one Pipeline job per application, while Jenkins performs the
actual checkout, build, test, and deployment on that VPS. Saving a job never
runs Docker on the desktop computer.

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

1. Use **Ansible → Docker Engine**, enter every Linux account that needs Docker
   access (normally the SSH user and `jenkins`), and run the idempotent profile.
2. Use **Ansible → Jenkins** to install Jenkins on the target VPS.
3. Use **Verify Jenkins** to check the service, startup state, listener, Docker
   group membership, and Docker daemon access. **Restart Jenkins** performs a
   confirmed service restart without deleting jobs, plugins, credentials, or
   build history.
4. Complete the Jenkins setup wizard and install the suggested plugins. The Pipeline, Git,
   Folders, Credentials, and Plain Credentials plugins are required.
5. In Jenkins, open **your user → Security → API Token**, create a token, and copy it once.
   The similarly named token controls under **Manage Jenkins → Security** are global policy;
   they do not display a personal API token.
6. In **Secrets**, create a **Jenkins** credential containing the Jenkins username, API token,
   and optional full URL (for example `http://203.0.113.10:8080`).
7. For private repositories, create a **GitHub** credential in Secrets. CloudForge installs it
   into the target's Jenkins folder; after credential creation, the token is never returned to
   the renderer or written to pipeline persistence/logs.
8. Create a **Deployment Environment File** credential for `.env.production`.
   Paste the complete file in CloudForge. You can edit it later from **Secrets**
   without recreating the pipeline or committing production secrets to Git.

The commonly required Jenkins plugin IDs are `workflow-aggregator`, `git`,
`cloudbees-folder`, `credentials`, and `plain-credentials`. GitHub or GitLab
authentication plugins are optional unless the Jenkinsfile uses their specific
features.

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

Select an **Encrypted deployment environment file** when the repository needs
`.env.production`, `.env`, or another runtime configuration file. CloudForge
decrypts it only in the main process, stores a base64 secret-text credential in
the isolated Jenkins folder, and synchronizes its generated ID through
`CLOUDFORGE_ENV_CREDENTIAL_ID`. The Jenkinsfile decodes it with owner-only
permissions for the build and deletes the temporary file after every run.
Updating the CloudForge credential and saving the pipeline updates the existing
Jenkins secret in place.
The generated parameter is read-only in the run form. Parameter synchronization
reconstructs its value from the selected encrypted environment, so an empty
default reported by the repository Jenkinsfile cannot erase the managed Jenkins
credential reference.
Before saving or running a pipeline, CloudForge validates the decrypted
environment for `CHANGE_ME_*` placeholders and reports only the affected
variable names. It never reports their values. Every build also refreshes the
folder-scoped Jenkins secret from the current CloudForge credential, so editing
the credential does not require manually changing Jenkins.

Temporarily optional integrations can explicitly allow selected placeholders:

```dotenv
CLOUDFORGE_OPTIONAL_PLACEHOLDERS=MAIL_HOST,MAIL_FROM_ADDRESS
```

Only the listed keys are ignored. Required database, application-key, Redis, and
other unlisted placeholders continue to block deployment.

**Save to Jenkins** only creates or updates the remote job. It does not start a
build. Pushing a commit also does not start a job unless a GitHub webhook or an
SCM polling trigger has been configured separately.

## Domain automation

Enable **Configure application domain**, provide `app.example.com` and the host port exposed by
the application. CloudForge then reuses the selected/default Cloudflare credential to create or
update the DNS origin record and applies a validated Nginx reverse proxy to `127.0.0.1:<port>`.
If that hostname already exists as a CNAME, CloudForge updates the existing record in place to the
required A or AAAA origin record. Repeated pipeline saves therefore remain idempotent instead of
failing with Cloudflare's same-name record conflict.
Issue the first certificate from **SSL & Domains** after the application is reachable; scheduled
renewal remains owned by that module.

CloudForge synchronizes the selected application port into the Jenkins
`HOST_PORT` string parameter. When a build is queued, declared parameter defaults
are sent explicitly, so a repository Jenkinsfile can publish its container with
`-p "${HOST_PORT}:<container-port>"`. The port is a per-pipeline value, not a
hardcoded VPS default. For example, a container listening internally on `8080`
can use host port `8000`; Nginx then routes the domain to `127.0.0.1:8000`.

Repository Jenkinsfiles should still define a safe default for direct/manual
Jenkins runs:

```groovy
parameters {
    string(name: 'HOST_PORT', defaultValue: '8000')
}
environment {
    HOST_PORT = "${params.HOST_PORT ?: '8000'}"
}
```

For SCM pipelines, Jenkins learns the repository's declarative parameters only
after it evaluates the Jenkinsfile during the first build. After that first
build, click **Status / sync parameters** in CloudForge. CloudForge imports the
definitions and displays choice, string, boolean, and password inputs in the
**Run pipeline** card. The synchronized definitions are persisted, so later
application restarts keep the same deployment controls.
While synchronization is running, the button shows a loading state. When it
finishes, CloudForge reports the number of parameters synchronized, reports that
the pipeline has no parameters, or displays the Jenkins error.

The fallback matters on the very first Jenkins build because parameters declared
by a Jenkinsfile may not be available until Jenkins has evaluated that file once.

Applications with a second internal service, such as Laravel Reverb, may add
**Additional application routes**. For HanoutPlus, the main HTTP route uses VPS
loopback port `8001`; `/app` and `/apps` route to Reverb on loopback port `8081`.
Redis uses container-internal port `9000` and is not opened in OCI, UFW, or
Nginx. MySQL and Redis stay private to the Docker network.

For Laravel Compose applications, CloudForge and Jenkins manage the runtime
without manual commands: Compose creates the private network and named volumes,
Supervisor runs Apache, queue workers, Reverb, and `artisan schedule:work`, and
Jenkins performs idempotent builds, migrations, health checks, and cleanup.

## Run and observe

Select a saved pipeline, fill its parameters, and choose **Run pipeline**. CloudForge queues the
build through Jenkins' crumb-protected API and refreshes job status every 15 seconds. Creation,
updates, runs, failures, domain setup, and deletion are recorded in Activity history without
tokens or secret values.

After the first run, open the job in Jenkins and select its build number →
**Console Output**. A successful container pipeline normally shows checkout,
image build, tests, deployment, and cleanup. **No builds** means the job exists
but has never been queued. Re-running an Ansible profile or restarting Jenkins
does not queue an application build.

Deleting a CloudForge-managed pipeline removes the remote Jenkins job first,
then its local record. Its per-VPS folder is removed only when empty. Refreshing
the page reconciles the saved CloudForge state with the remote job status.

## Troubleshooting

- **401/403** — create a Jenkins API token for the exact username stored in Secrets.
- **404 creating folders/jobs** — install Pipeline, Folders, Git, and Credentials plugins.
- **Connection timeout** — open the Jenkins port in OCI and the VPS firewall, or use an HTTPS
  Nginx domain as the Jenkins URL.
- **Git authentication failure** — select a GitHub credential with repository read permission.
- **Domain setup failed** — verify the default Cloudflare credential/zone and that Nginx is
  running on the target.
- **`HOST_PORT: parameter not set`** — re-save the pipeline after setting its
  application port, then run it from CloudForge. Also keep the first-build
  fallback shown above in repository Jenkinsfiles.
- **Build succeeds but the domain is unavailable** — confirm the container is
  listening on the same host port shown in the Nginx site, then verify ports 80
  and 443 in the provider and VPS firewalls.
- **Push did not start a build** — use **Run pipeline** or Jenkins **Build with
  Parameters**. Git webhook automation is a separate trigger configuration.
