import { createHash, randomUUID } from 'node:crypto';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import type {
  AnsibleEventSink,
  AnsibleAccessDetails,
  AnsibleManager,
  AnsibleOutcome,
  AnsibleProfile,
  AnsibleProfileId,
  AnsibleRunOptions,
  AnsibleStatus,
  DeploymentTarget,
  NginxSite,
  VpsPreflightReport,
} from '@cloudforge/core';
import { ANSIBLE_PROFILES, getPlaybook } from './ansible-playbooks.js';
import {
  buildPreflightReport,
  ownedService,
  parsePreflightOutput,
  preflightCommand,
  profilePort,
  profileRepositoryHost,
} from './vps-preflight.js';

const CONNECT_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30 * 60_000;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOST_PATTERN =
  /^(?:localhost|[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/;

export class SshAnsibleManager implements AnsibleManager {
  profiles(): readonly AnsibleProfile[] {
    return ANSIBLE_PROFILES;
  }

  inspectHostKey(host: string, port: number): Promise<Result<string, DeploymentError>> {
    return inspectHostKey(host, port);
  }

  async status(target: DeploymentTarget): Promise<Result<AnsibleStatus, DeploymentError>> {
    const result = await withConnection(target, undefined, (client) =>
      execute(
        client,
        'if [ -x /opt/cloudforge/ansible/bin/ansible-playbook ]; then /opt/cloudforge/ansible/bin/ansible-playbook --version | head -n 1; else exit 3; fi',
      ),
    );
    if (!result.ok) {
      if (result.error.message.includes('exit 3')) return ok({ installed: false, version: null });
      return result;
    }
    return ok({ installed: true, version: result.value.stdout.trim() || 'ansible-playbook' });
  }

  async preflight(
    target: DeploymentTarget,
    profileId?: AnsibleProfileId,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<Result<VpsPreflightReport, DeploymentError>> {
    const port = profilePort(profileId, variables);
    const result = await withConnection(target, undefined, (client) =>
      execute(
        client,
        preflightCommand(port, ownedService(profileId), profileRepositoryHost(profileId)),
      ),
    );
    if (!result.ok) return result;
    return ok(buildPreflightReport(parsePreflightOutput(result.value.stdout), profileId, port));
  }

  async repair(
    target: DeploymentTarget,
    onEvent?: AnsibleEventSink,
    options: AnsibleRunOptions = {},
  ): Promise<Result<VpsPreflightReport, DeploymentError>> {
    const before = await this.preflight(target);
    if (!before.ok) return before;
    if (before.value.status === 'blocked')
      return err(new DeploymentError('Resolve blocked preflight checks before repairing this VPS'));
    const installed = await this.bootstrap(target, onEvent, options);
    if (!installed.ok) return installed;
    const after = await this.preflight(target);
    if (after.ok) onEvent?.({ stream: 'step', message: 'Target prerequisite repair completed.' });
    return after;
  }

  async bootstrap(
    target: DeploymentTarget,
    onEvent?: AnsibleEventSink,
    options: AnsibleRunOptions = {},
  ): Promise<Result<AnsibleStatus, DeploymentError>> {
    const current = await this.status(target);
    if (!current.ok) return current;
    onEvent?.({
      stream: 'step',
      message: current.value.installed
        ? 'Verifying and updating target prerequisites…'
        : 'Installing target prerequisites and isolated Ansible runtime…',
    });
    const command = `set -eu
if [ "$(id -u)" -eq 0 ]; then SUDO=''; else SUDO='sudo -n'; fi
PYTHON=''
WAITED=0
if command -v apt-get >/dev/null 2>&1; then
  while pgrep -x 'apt|apt-get|dpkg' >/dev/null 2>&1; do [ "$WAITED" -ge 120 ] && { echo 'Package manager remained busy for 120 seconds' >&2; exit 4; }; sleep 2; WAITED=$((WAITED+2)); done
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl iproute2 python3 python3-venv python3-pip
  PYTHON="$(command -v python3)"
elif command -v dnf >/dev/null 2>&1; then
  $SUDO dnf install -y ca-certificates curl iproute python3.11 python3.11-pip || $SUDO dnf install -y ca-certificates curl iproute python3 python3-pip
  PYTHON="$(command -v python3.11 || command -v python3)"
elif command -v yum >/dev/null 2>&1; then
  $SUDO yum install -y ca-certificates curl iproute python3.11 python3.11-pip || $SUDO yum install -y ca-certificates curl iproute python3 python3-pip
  PYTHON="$(command -v python3.11 || command -v python3)"
else
  echo 'Unsupported package manager (apt, dnf, or yum required)' >&2; exit 2
fi
$SUDO mkdir -p /opt/cloudforge
$SUDO "$PYTHON" -m venv /opt/cloudforge/ansible
$SUDO /opt/cloudforge/ansible/bin/pip install --disable-pip-version-check --upgrade 'ansible-core>=2.16,<2.22'
/opt/cloudforge/ansible/bin/ansible-playbook --version | head -n 1`;
    const result = await withConnection(target, options.signal, (client) =>
      execute(client, command, onEvent, options.signal),
    );
    if (!result.ok) return result;
    onEvent?.({ stream: 'step', message: 'Ansible runtime is ready.' });
    return ok({ installed: true, version: result.value.stdout.trim() });
  }

  async run(
    target: DeploymentTarget,
    profileId: AnsibleProfileId,
    variables: Readonly<Record<string, unknown>>,
    onEvent?: AnsibleEventSink,
    options: AnsibleRunOptions = {},
  ): Promise<Result<AnsibleOutcome, DeploymentError>> {
    const profile = ANSIBLE_PROFILES.find((item) => item.id === profileId);
    if (!profile) return err(new DeploymentError(`Unknown Ansible profile: ${profileId}`));
    const validated = validateVariables(profile, variables);
    if (!validated.ok) return validated;
    const readiness = await this.preflight(target, profileId, validated.value);
    if (!readiness.ok) return readiness;
    if (readiness.value.status !== 'ready')
      return err(
        new DeploymentError('Run Preflight and Prepare target before executing this profile'),
      );
    if (profileId === 'dockhand' || profileId === 'portainer') {
      onEvent?.({ stream: 'step', message: 'Ensuring the Docker dependency is ready…' });
      const docker = await this.run(target, 'docker', { docker_users: '' }, onEvent, options);
      if (!docker.ok) return docker;
    }

    const job = `/tmp/cloudforge-ansible-${randomUUID()}`;
    onEvent?.({ stream: 'step', message: `Running ${profile.name}…` });
    const result = await withConnection(target, options.signal, async (client) => {
      await execute(client, `mkdir -m 700 ${job}`);
      try {
        await upload(client, `${job}/playbook.yml`, getPlaybook(profileId));
        await upload(client, `${job}/vars.json`, JSON.stringify(validated.value));
        onEvent?.({ stream: 'step', message: 'Validating playbook syntax…' });
        await execute(
          client,
          `cd ${job}; ANSIBLE_NOCOLOR=1 /opt/cloudforge/ansible/bin/ansible-playbook -i localhost, -c local playbook.yml --extra-vars @vars.json --syntax-check`,
          onEvent,
          options.signal,
        );
        const command = `set -eu; cd ${job}; ANSIBLE_NOCOLOR=1 /opt/cloudforge/ansible/bin/ansible-playbook -i localhost, -c local playbook.yml --extra-vars @vars.json`;
        return await execute(client, command, onEvent, options.signal);
      } finally {
        await execute(client, `rm -rf ${job}`).catch(() => undefined);
      }
    });
    if (!result.ok) return result;
    const verified = await postCheck(target, profileId, validated.value, onEvent, options.signal);
    if (!verified.ok) return verified;
    if (profileId === 'jenkins') {
      const port = profilePort(profileId, validated.value) ?? 8080;
      const urlHost =
        target.host.includes(':') && !target.host.startsWith('[')
          ? `[${target.host}]`
          : target.host;
      onEvent?.({ stream: 'step', message: `Jenkins web UI: http://${urlHost}:${port}` });
      onEvent?.({
        stream: 'step',
        message: 'Initial unlock password: sudo cat /var/lib/jenkins/secrets/initialAdminPassword',
      });
    }
    onEvent?.({ stream: 'step', message: `${profile.name} is ready.` });
    return ok({ success: true, summary: recap(result.value.stdout) });
  }

  async access(
    target: DeploymentTarget,
    profileId: AnsibleProfileId,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Result<AnsibleAccessDetails | null, DeploymentError>> {
    if (profileId !== 'jenkins') return ok(null);
    const profile = ANSIBLE_PROFILES.find((item) => item.id === profileId);
    if (!profile) return err(new DeploymentError(`Unknown Ansible profile: ${profileId}`));
    const validated = validateVariables(profile, variables);
    if (!validated.ok) return validated;
    const port = profilePort(profileId, validated.value) ?? 8080;
    const result = await withConnection(target, undefined, (client) =>
      execute(
        client,
        `if [ "$(id -u)" -eq 0 ]; then SUDO=''; else SUDO='sudo -n'; fi; if $SUDO test -r /var/lib/jenkins/secrets/initialAdminPassword; then $SUDO cat /var/lib/jenkins/secrets/initialAdminPassword; fi`,
      ),
    );
    if (!result.ok) return result;
    const urlHost =
      target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host;
    const secret = result.value.stdout.trim() || null;
    return ok({
      profileId,
      url: `http://${urlHost}:${port}`,
      secretLabel: 'Initial unlock password',
      secret,
      instructions: secret
        ? 'Use this one-time password to unlock Jenkins, then create the first administrator account.'
        : 'The initial password is unavailable. Jenkins may already have completed its setup wizard.',
    });
  }

  async listNginxSites(target: DeploymentTarget): Promise<Result<NginxSite[], DeploymentError>> {
    const command = `if [ "$(id -u)" -eq 0 ]; then SUDO=''; else SUDO='sudo -n'; fi; $SUDO sh -c 'for f in /etc/nginx/conf.d/cloudforge-*.conf; do [ -f "$f" ] || continue; sed -n "1,4p" "$f"; echo "# cloudforge-end"; done'`;
    const result = await withConnection(target, undefined, (client) => execute(client, command));
    if (!result.ok) return result;
    try {
      const sites = result.value.stdout.split('# cloudforge-end').flatMap((block) => {
        const value = (key: string): string | undefined =>
          new RegExp(`^# cloudforge-${key}: (.+)$`, 'm').exec(block)?.[1]?.trim();
        const domain = value('domain');
        const upstream = value('upstream');
        if (!domain || !upstream) return [];
        const separator = upstream.lastIndexOf(':');
        return [
          {
            domain,
            upstreamHost: upstream.slice(0, separator),
            upstreamPort: Number(upstream.slice(separator + 1)),
            websocket: value('websocket') === 'true',
          },
        ];
      });
      return ok(sites);
    } catch (cause) {
      return err(new DeploymentError('Could not parse managed Nginx sites', { cause }));
    }
  }

  async upsertNginxSite(
    target: DeploymentTarget,
    site: NginxSite,
    onEvent?: AnsibleEventSink,
    options: AnsibleRunOptions = {},
  ): Promise<Result<AnsibleOutcome, DeploymentError>> {
    const checked = validateNginxSite(site);
    if (!checked.ok) return checked;
    const nginx = await this.run(target, 'nginx', {}, onEvent, options);
    if (!nginx.ok) return nginx;
    const job = `/tmp/cloudforge-nginx-${randomUUID()}`;
    const file = `/etc/nginx/conf.d/cloudforge-${site.domain.replaceAll('.', '-')}.conf`;
    const result = await withConnection(target, options.signal, async (client) => {
      await upload(client, job, renderManagedNginxSite(site));
      onEvent?.({ stream: 'step', message: `Validating Nginx configuration for ${site.domain}…` });
      const command = privilegedScript(`
set -eu
backup='${job}.backup'
had=0
if [ -f '${file}' ]; then cp '${file}' "$backup"; had=1; fi
install -m 0644 '${job}' '${file}'
if ! nginx -t; then
  if [ "$had" -eq 1 ]; then cp "$backup" '${file}'; else rm -f '${file}'; fi
  nginx -t >/dev/null 2>&1 || true
  rm -f '${job}' "$backup"
  exit 1
fi
systemctl reload nginx
rm -f '${job}' "$backup"
`);
      return execute(client, command, onEvent, options.signal);
    });
    if (!result.ok) return result;
    onEvent?.({
      stream: 'step',
      message: `Nginx now routes ${site.domain} to ${site.upstreamHost}:${site.upstreamPort}.`,
    });
    return ok({ success: true, summary: 'Configuration validated and Nginx reloaded.' });
  }

  async removeNginxSite(
    target: DeploymentTarget,
    domain: string,
    onEvent?: AnsibleEventSink,
    options: AnsibleRunOptions = {},
  ): Promise<Result<AnsibleOutcome, DeploymentError>> {
    if (!DOMAIN_PATTERN.test(domain))
      return err(new DeploymentError('Enter a valid lowercase domain name'));
    const file = `/etc/nginx/conf.d/cloudforge-${domain.replaceAll('.', '-')}.conf`;
    onEvent?.({ stream: 'step', message: `Removing ${domain}…` });
    const result = await withConnection(target, options.signal, (client) =>
      execute(
        client,
        privilegedScript(`set -eu; rm -f '${file}'; nginx -t; systemctl reload nginx`),
        onEvent,
        options.signal,
      ),
    );
    if (!result.ok) return result;
    return ok({
      success: true,
      summary: 'Site removed, configuration validated, and Nginx reloaded.',
    });
  }
}

async function postCheck(
  target: DeploymentTarget,
  profileId: AnsibleProfileId,
  variables: Readonly<Record<string, unknown>>,
  onEvent?: AnsibleEventSink,
  signal?: AbortSignal,
): Promise<Result<void, DeploymentError>> {
  onEvent?.({ stream: 'step', message: 'Verifying service health…' });
  const privileged = `if [ "$(id -u)" -eq 0 ]; then S=''; else S='sudo -n'; fi;`;
  const commands: Record<AnsibleProfileId, string> = {
    docker: `${privileged} $S systemctl is-active docker; $S docker version --format '{{.Server.Version}}'; $S docker compose version`,
    dockhand: `${privileged} $S docker inspect -f '{{.State.Status}}' dockhand | grep -qx running`,
    portainer: `${privileged} $S docker inspect -f '{{.State.Status}}' portainer | grep -qx running`,
    jenkins: `${privileged} $S systemctl is-active jenkins; command -v ss >/dev/null && ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)${profilePort(profileId, variables) ?? 8080}$'`,
    nginx: `${privileged} $S nginx -t; $S systemctl is-active nginx`,
  };
  const result = await withConnection(target, signal, (client) =>
    execute(client, commands[profileId], onEvent, signal),
  );
  if (!result.ok) return result;
  onEvent?.({ stream: 'step', message: 'Post-deployment health check passed.' });
  return ok(undefined);
}

function validateVariables(
  profile: AnsibleProfile,
  input: Readonly<Record<string, unknown>>,
): Result<Record<string, unknown>, DeploymentError> {
  const output: Record<string, unknown> = {};
  for (const spec of profile.variables) {
    const raw = input[spec.key] ?? spec.defaultValue;
    if (spec.required && (raw === undefined || raw === ''))
      return err(new DeploymentError(`${spec.label} is required`));
    if (raw === undefined || raw === '') continue;
    if (spec.type === 'number') {
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1 || number > 65535)
        return err(new DeploymentError(`${spec.label} must be a port between 1 and 65535`));
      output[spec.key] = number;
    } else if (spec.type === 'boolean') output[spec.key] = raw === true || raw === 'true';
    else {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean')
        return err(new DeploymentError(`${spec.label} is invalid`));
      const value = String(raw).trim();
      if (value.length > 500 || /[\r\n\0]/.test(value))
        return err(new DeploymentError(`${spec.label} is invalid`));
      output[spec.key] = value;
    }
  }
  return ok(output);
}

export function validateNginxSite(site: NginxSite): Result<void, DeploymentError> {
  if (!DOMAIN_PATTERN.test(site.domain))
    return err(new DeploymentError('Enter a valid lowercase domain name'));
  if (!HOST_PATTERN.test(site.upstreamHost))
    return err(new DeploymentError('Enter a valid upstream hostname or IP address'));
  if (!Number.isInteger(site.upstreamPort) || site.upstreamPort < 1 || site.upstreamPort > 65535)
    return err(new DeploymentError('Upstream port must be between 1 and 65535'));
  return ok(undefined);
}

export function renderManagedNginxSite(site: NginxSite): string {
  const websocket = site.websocket
    ? `
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";`
    : '';
  return `# cloudforge-domain: ${site.domain}
# cloudforge-upstream: ${site.upstreamHost}:${site.upstreamPort}
# cloudforge-websocket: ${String(site.websocket)}
# Managed by CloudForge. Changes may be overwritten.
server {
  listen 80;
  listen [::]:80;
  server_name ${site.domain};
  location / {
    proxy_pass http://${site.upstreamHost}:${site.upstreamPort};
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;${websocket}
  }
}
`;
}

function privilegedScript(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const path = `/tmp/cloudforge-root-${randomUUID()}.sh`;
  return `printf '%s' '${encoded}' | base64 -d > ${path} && chmod 700 ${path} && if [ "$(id -u)" -eq 0 ]; then ${path}; else sudo -n ${path}; fi; code=$?; rm -f ${path}; exit $code`;
}

function withConnection<T>(
  target: DeploymentTarget,
  signal: AbortSignal | undefined,
  action: (client: Client) => Promise<T>,
): Promise<Result<T, DeploymentError>> {
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (result: Result<T, DeploymentError>): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      client.end();
      resolve(result);
    };
    const abort = (): void => finish(err(new DeploymentError('Ansible operation cancelled')));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    client.once('error', (cause) =>
      finish(
        err(
          new DeploymentError('Ansible SSH connection or host-key verification failed', { cause }),
        ),
      ),
    );
    client.once(
      'ready',
      () =>
        void action(client)
          .then((value) => finish(ok(value)))
          .catch((cause) =>
            finish(
              err(
                cause instanceof DeploymentError
                  ? cause
                  : new DeploymentError('Remote Ansible operation failed', { cause }),
              ),
            ),
          ),
    );
    client.connect(connectionConfig(target));
  });
}

function connectionConfig(target: DeploymentTarget): ConnectConfig {
  if (!target.privateKey && !target.password)
    throw new DeploymentError('An SSH private key or password is required');
  return {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    hostVerifier: (key: Buffer) =>
      normalizeFingerprint(fingerprintHostKey(key)) === normalizeFingerprint(target.hostKeySha256),
    ...(target.privateKey ? { privateKey: target.privateKey } : {}),
    ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    ...(target.password ? { password: target.password } : {}),
  };
}

function execute(
  client: Client,
  command: string,
  onEvent?: AnsibleEventSink,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (cause?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (cause) reject(cause);
        else
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
      };
      const abort = (): void => {
        stream.close();
        finish(new DeploymentError('Ansible operation cancelled'));
      };
      const timer = setTimeout(() => {
        stream.close();
        finish(new DeploymentError('Remote Ansible command timed out'));
      }, COMMAND_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      stream.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        onEvent?.({ stream: 'stdout', message: chunk.toString('utf8') });
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        onEvent?.({ stream: 'stderr', message: chunk.toString('utf8') });
      });
      stream.on('close', (code: number | null) => {
        if (code === 0) finish();
        else
          finish(
            new DeploymentError(
              Buffer.concat(stderr).toString('utf8').trim() ||
                `Remote command failed with exit ${code ?? 'unknown'}`,
            ),
          );
      });
    });
  });
}

function upload(client: Client, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) =>
    client.sftp((error, sftp: SFTPWrapper) => {
      if (error) return reject(error);
      sftp.writeFile(path, Buffer.from(content, 'utf8'), { mode: 0o600 }, (writeError) =>
        writeError ? reject(writeError) : resolve(),
      );
    }),
  );
}

function inspectHostKey(host: string, port: number): Promise<Result<string, DeploymentError>> {
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (result: Result<string, DeploymentError>): void => {
      if (settled) return;
      settled = true;
      client.end();
      resolve(result);
    };
    client.once('error', (cause) =>
      finish(err(new DeploymentError('Failed to inspect SSH host key', { cause }))),
    );
    client.connect({
      host,
      port,
      username: 'cloudforge-host-key-inspection',
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        finish(ok(fingerprintHostKey(key)));
        return false;
      },
    });
  });
}

function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}

function recap(stdout: string): string {
  const match = /localhost\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)/.exec(
    stdout,
  );
  return match
    ? `ok=${match[1]}, changed=${match[2]}, unreachable=${match[3]}, failed=${match[4]}`
    : 'Playbook completed successfully.';
}
