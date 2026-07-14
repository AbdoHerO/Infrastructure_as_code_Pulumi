import { createHash, randomUUID } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import {
  type DeploymentTarget,
  type ManagedNginxSite,
  type NginxBackup,
  type NginxEventSink,
  type NginxLiveStatus,
  type NginxLogQuery,
  type NginxManager,
  type NginxOperationOutcome,
  type NginxOverview,
} from '@cloudforge/core';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';

const CONNECT_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 120_000;
const BACKUP_DIR = '/var/lib/cloudforge/nginx/backups';

export class SshNginxManager implements NginxManager {
  inspect(target: DeploymentTarget): Promise<Result<NginxOverview, DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      const result = await execute(
        client,
        privileged(`
native=0; command -v nginx >/dev/null 2>&1 && native=1
container=""; command -v docker >/dev/null 2>&1 && container=$(docker ps --filter ancestor=nginx --format '{{.Names}}' | head -n1 || true)
if [ "$native" = 1 ]; then
  version=$(nginx -v 2>&1 | sed 's#nginx/##')
  systemctl is-active --quiet nginx && running=1 || running=0
  systemctl is-enabled --quiet nginx && enabled=1 || enabled=0
  nginx -t >/tmp/cloudforge-nginx-test 2>&1 && config=valid || config=invalid
  message=$(tail -n2 /tmp/cloudforge-nginx-test | tr '\\n' ' ')
  installation=native
elif [ -n "$container" ]; then
  version=$(docker exec "$container" nginx -v 2>&1 | sed 's#nginx/##')
  running=1; enabled=1; installation=docker
  docker exec "$container" nginx -t >/tmp/cloudforge-nginx-test 2>&1 && config=valid || config=invalid
  message=$(tail -n2 /tmp/cloudforge-nginx-test | tr '\\n' ' ')
else
  version=''; running=0; enabled=0; installation=not-installed; config=unknown; message='Nginx is not installed.'
fi
sites=$(find /etc/nginx/conf.d /etc/nginx/sites-enabled -maxdepth 1 -type f 2>/dev/null | sort -u | wc -l)
ssl=$(grep -RhsE '^\\s*ssl_certificate\\s' /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null | wc -l)
reload_at=$(cat /var/lib/cloudforge/nginx/last-reload-at 2>/dev/null || true)
reload_ok=$(cat /var/lib/cloudforge/nginx/last-reload-ok 2>/dev/null || true)
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$installation" "$version" "$running" "$enabled" "$config" "$sites" "$ssl" "$reload_at" "$reload_ok" "$message"
`),
      );
      const [
        installation = 'not-installed',
        version = '',
        running = '0',
        enabled = '0',
        configStatus = 'unknown',
        sites = '0',
        ssl = '0',
        reloadAt = '',
        reloadOk = '',
        ...message
      ] = result.stdout.trim().split('\t');
      return {
        installation: installation as NginxOverview['installation'],
        version: version || null,
        running: running === '1',
        enabled: enabled === '1',
        configStatus: configStatus as NginxOverview['configStatus'],
        configMessage: message.join('\t'),
        siteCount: Number(sites) || 0,
        sslDomainCount: Number(ssl) || 0,
        lastReloadAt: reloadAt || null,
        lastReloadSucceeded: reloadOk === '' ? null : reloadOk === '1',
      };
    });
  }

  listSites(target: DeploymentTarget): Promise<Result<ManagedNginxSite[], DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      const { stdout } = await execute(
        client,
        privileged(
          `grep -Rhs '^# cloudforge-site: ' /etc/nginx/conf.d /etc/nginx/sites-available 2>/dev/null || true`,
        ),
      );
      const managed = stdout.split('\n').flatMap((line) => {
        const encoded = line.replace(/^# cloudforge-site:\s*/, '').trim();
        if (!encoded) return [];
        try {
          return [
            {
              ...(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ManagedNginxSite),
              managed: true,
            },
          ];
        } catch {
          return [];
        }
      });
      const files = await execute(
        client,
        privileged(
          `for f in /etc/nginx/conf.d/* /etc/nginx/sites-enabled/*; do [ -f "$f" ] || continue; printf '%s\\t' "$f"; base64 -w0 "$f"; printf '\\n'; done`,
        ),
      );
      const known = new Set(managed.map((site) => site.domain));
      const discovered = files.stdout.split('\n').flatMap((line) => {
        const separator = line.indexOf('\t');
        if (separator < 1) return [];
        const path = line.slice(0, separator);
        const config = Buffer.from(line.slice(separator + 1), 'base64').toString('utf8');
        const serverNames = [...config.matchAll(/\bserver_name\s+([^;]+);/g)].flatMap(
          (match) => match[1]?.trim().split(/\s+/) ?? [],
        );
        const upstream = /proxy_pass\s+https?:\/\/([^/:;]+)(?::(\d+))?/.exec(config);
        return serverNames
          .filter((domain) => domain !== '_' && !known.has(domain))
          .map((domain) => ({
            domain,
            enabled: path.includes('/sites-enabled/') || path.endsWith('.conf'),
            upstreamKind: 'host' as const,
            upstreamHost: upstream?.[1] ?? 'unknown',
            upstreamPort: Number(upstream?.[2]) || 80,
            websocket: /proxy_set_header\s+Upgrade/i.test(config),
            ssl: /listen\s+443|ssl_certificate\s/i.test(config),
            httpRedirect: /return\s+30[18]\s+https:/i.test(config),
            headers: [],
            extraDirectives: [],
            locations: [],
            proxyTimeoutSeconds: 60,
            clientMaxBodySize: /client_max_body_size\s+([^;]+)/.exec(config)?.[1] ?? '1m',
            compression: /gzip\s+on/.test(config),
            cache: /proxy_cache\s/.test(config),
            customSnippets: [],
            lastModified: null,
            managed: false,
            configPath: path,
          }));
      });
      return [...managed, ...discovered];
    });
  }

  applySite(
    target: DeploymentTarget,
    site: ManagedNginxSite,
    renderedConfig: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>> {
    const safeName = site.domain.replace(/^\*\./, 'wildcard.').replace(/[^a-z0-9.-]/gi, '-');
    const path = `/etc/nginx/conf.d/cloudforge-${safeName}.conf`;
    return this.transaction(
      target,
      `save-site-${safeName}`,
      `printf '%s' '${base64(renderedConfig)}' | base64 -d > '${path}'\n${site.enabled ? '' : `mv '${path}' '${path}.disabled'`}`,
      onEvent,
    );
  }

  removeSite(
    target: DeploymentTarget,
    domain: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>> {
    const safeName = domain.replace(/^\*\./, 'wildcard.').replace(/[^a-z0-9.-]/gi, '-');
    return this.transaction(
      target,
      `remove-site-${safeName}`,
      `rm -f '/etc/nginx/conf.d/cloudforge-${safeName}.conf' '/etc/nginx/conf.d/cloudforge-${safeName}.conf.disabled'`,
      onEvent,
    );
  }

  readMainConfig(target: DeploymentTarget): Promise<Result<string, DeploymentError>> {
    return withConnection(
      target,
      undefined,
      async (client) => (await execute(client, privileged('cat /etc/nginx/nginx.conf'))).stdout,
    );
  }

  saveMainConfig(
    target: DeploymentTarget,
    content: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>> {
    return this.transaction(
      target,
      'save-main-config',
      `printf '%s' '${base64(content)}' | base64 -d > /etc/nginx/nginx.conf`,
      onEvent,
    );
  }

  reload(
    target: DeploymentTarget,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      onEvent?.({ stream: 'step', message: 'Validating Nginx configuration before reload' });
      await execute(client, privileged(reloadScript()), onEvent);
      return { summary: 'Nginx configuration is valid and the service was reloaded.' };
    });
  }

  liveStatus(target: DeploymentTarget): Promise<Result<NginxLiveStatus, DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      const { stdout } = await execute(
        client,
        privileged(`
workers=$(pgrep -fc 'nginx: worker process' || true)
reloads=$(journalctl -u nginx --no-pager 2>/dev/null | grep -ci reload || true)
errors=$(tail -n 1000 /var/log/nginx/error.log 2>/dev/null | grep -ciE '\\[error\\]|\\[crit\\]|\\[alert\\]|\\[emerg\\]' || true)
stub=$(curl -fsS http://127.0.0.1/nginx_status 2>/dev/null || true)
active=$(printf '%s' "$stub" | awk '/Active connections/ {print $3}')
set -- $(printf '%s' "$stub" | awk 'NR==3 {print $1, $2, $3}')
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$workers" "\${active:-}" "\${1:-}" "\${2:-}" "\${3:-}" "$reloads" "$errors"
`),
      );
      const [workers, active, accepted, handled, requests, reloads, errors] = stdout
        .trim()
        .split('\t');
      return {
        workers: nullableNumber(workers),
        activeConnections: nullableNumber(active),
        acceptedConnections: nullableNumber(accepted),
        handledConnections: nullableNumber(handled),
        requests: nullableNumber(requests),
        reloadCount: Number(reloads) || 0,
        recentErrors: Number(errors) || 0,
      };
    });
  }

  readLogs(
    target: DeploymentTarget,
    query: NginxLogQuery,
  ): Promise<Result<string[], DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      const path =
        query.kind === 'access' ? '/var/log/nginx/access.log' : '/var/log/nginx/error.log';
      const { stdout } = await execute(
        client,
        privileged(`tail -n ${query.limit ?? 300} '${path}' 2>/dev/null || true`),
      );
      const search = query.search?.toLowerCase();
      return stdout
        .split('\n')
        .filter((line) => line && (!search || line.toLowerCase().includes(search)));
    });
  }

  listBackups(target: DeploymentTarget): Promise<Result<NginxBackup[], DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      const { stdout } = await execute(
        client,
        privileged(
          `find '${BACKUP_DIR}' -maxdepth 1 -type f -name '*.tar.gz' -printf '%f\\t%TY-%Tm-%TdT%TH:%TM:%TSZ\\n' 2>/dev/null | sort -r`,
        ),
      );
      return stdout.split('\n').flatMap((line) => {
        const [file, createdAt] = line.split('\t');
        return file && createdAt
          ? [
              {
                id: file.replace(/\.tar\.gz$/, ''),
                createdAt,
                reason: file.replace(/\.tar\.gz$/, '').replace(/^\d+-[a-f0-9]+-/, ''),
              },
            ]
          : [];
      });
    });
  }

  readBackupConfig(
    target: DeploymentTarget,
    backupId: string,
  ): Promise<Result<string, DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      const { stdout } = await execute(
        client,
        privileged(
          `test -f '${BACKUP_DIR}/${backupId}.tar.gz' && tar -xOzf '${BACKUP_DIR}/${backupId}.tar.gz' etc/nginx/nginx.conf`,
        ),
      );
      return stdout;
    });
  }

  restore(
    target: DeploymentTarget,
    backupId: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      onEvent?.({ stream: 'step', message: `Restoring backup ${backupId}` });
      await execute(
        client,
        privileged(
          `test -f '${BACKUP_DIR}/${backupId}.tar.gz'\nrm -rf /etc/nginx\ntar -xzf '${BACKUP_DIR}/${backupId}.tar.gz' -C /\n${reloadScript()}`,
        ),
        onEvent,
      );
      return { summary: `Restored Nginx backup ${backupId}.`, backupId };
    });
  }

  private transaction(
    target: DeploymentTarget,
    reason: string,
    mutation: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>> {
    return withConnection(target, undefined, async (client) => {
      const backupId = `${Date.now()}-${randomUUID().slice(0, 8)}-${reason}`;
      onEvent?.({ stream: 'step', message: `Creating automatic backup ${backupId}` });
      await execute(
        client,
        privileged(
          `set -e\ncommand -v nginx >/dev/null 2>&1 || { echo 'Docker Nginx editing requires a standard host-mounted configuration and native nginx validation binary.' >&2; exit 1; }\nmkdir -p '${BACKUP_DIR}'\ntar -czf '${BACKUP_DIR}/${backupId}.tar.gz' /etc/nginx 2>/dev/null\n${mutation}\nif ! nginx -t; then\n  rm -rf /etc/nginx\n  tar -xzf '${BACKUP_DIR}/${backupId}.tar.gz' -C /\n  nginx -t\n  exit 1\nfi\n${reloadScript()}`,
        ),
        onEvent,
      );
      return { summary: 'Configuration validated and applied. Nginx was reloaded.', backupId };
    });
  }
}

function reloadScript(): string {
  return `mkdir -p /var/lib/cloudforge/nginx\nif ! nginx -t; then date -u +%Y-%m-%dT%H:%M:%SZ > /var/lib/cloudforge/nginx/last-reload-at; echo 0 > /var/lib/cloudforge/nginx/last-reload-ok; exit 1; fi\nif command -v systemctl >/dev/null 2>&1; then systemctl reload nginx; else nginx -s reload; fi\ndate -u +%Y-%m-%dT%H:%M:%SZ > /var/lib/cloudforge/nginx/last-reload-at\necho 1 > /var/lib/cloudforge/nginx/last-reload-ok`;
}
function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}
function nullableNumber(value: string | undefined): number | null {
  return value && Number.isFinite(Number(value)) ? Number(value) : null;
}
function privileged(script: string): string {
  const path = `/tmp/cloudforge-nginx-${randomUUID()}.sh`;
  return `printf '%s' '${base64(script)}' | base64 -d > ${path} && chmod 700 ${path} && if [ "$(id -u)" -eq 0 ]; then ${path}; else sudo -n ${path}; fi; code=$?; rm -f ${path}; exit $code`;
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
    const abort = (): void => finish(err(new DeploymentError('Nginx operation cancelled')));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    client.once('error', (cause) =>
      finish(
        err(new DeploymentError('Nginx SSH connection or host-key verification failed', { cause })),
      ),
    );
    client.once('ready', () => {
      void action(client)
        .then((value) => finish(ok(value)))
        .catch((cause) =>
          finish(
            err(
              cause instanceof DeploymentError
                ? cause
                : new DeploymentError('Remote Nginx operation failed', { cause }),
            ),
          ),
        );
    });
    try {
      client.connect(connectionConfig(target));
    } catch (cause) {
      finish(
        err(
          cause instanceof DeploymentError
            ? cause
            : new DeploymentError('Invalid SSH target', { cause }),
        ),
      );
    }
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
      normalizeFingerprint(fingerprint(key)) === normalizeFingerprint(target.hostKeySha256),
    ...(target.privateKey ? { privateKey: target.privateKey } : {}),
    ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    ...(target.password ? { password: target.password } : {}),
  };
}

function execute(
  client: Client,
  command: string,
  onEvent?: NginxEventSink,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) =>
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        stream.close();
        reject(new DeploymentError('Remote Nginx command timed out'));
      }, COMMAND_TIMEOUT_MS);
      stream.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        onEvent?.({ stream: 'stdout', message: chunk.toString('utf8') });
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        onEvent?.({ stream: 'stderr', message: chunk.toString('utf8') });
      });
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        const errorText = Buffer.concat(stderr).toString('utf8');
        if (code === 0)
          resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: errorText });
        else
          reject(
            new DeploymentError(
              errorText.trim() || `Remote command failed with exit ${code ?? 'unknown'}`,
            ),
          );
      });
    }),
  );
}
function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}
function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}

/** Shared infrastructure helper for adapters that operate on the same trusted VPS target. */
export function runPrivilegedRemote(
  target: DeploymentTarget,
  script: string,
  onEvent?: NginxEventSink,
): Promise<Result<{ stdout: string; stderr: string }, DeploymentError>> {
  return withConnection(target, undefined, (client) =>
    execute(client, privileged(script), onEvent),
  );
}
