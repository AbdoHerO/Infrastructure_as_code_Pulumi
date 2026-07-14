import { err, ok, type DeploymentError, type Result, ValidationError } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  ManagedNginxSite,
  NginxBackup,
  NginxEventSink,
  NginxLiveStatus,
  NginxLogQuery,
  NginxManager,
  NginxOperationOutcome,
  NginxOverview,
} from '../ports/nginx-manager.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type { DeploymentTarget } from '../ports/deployer.js';

export type NginxServiceError = ValidationError | DeploymentError;

export class NginxService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly nginx: NginxManager,
    private readonly activities: ActivityService,
  ) {}

  inspect(targetId: string): Promise<Result<NginxOverview, NginxServiceError>> {
    return this.withTarget(targetId, (target) => this.nginx.inspect(target));
  }

  listSites(targetId: string): Promise<Result<ManagedNginxSite[], NginxServiceError>> {
    return this.withTarget(targetId, (target) => this.nginx.listSites(target));
  }

  async saveSite(
    targetId: string,
    site: ManagedNginxSite,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, NginxServiceError>> {
    const valid = validateManagedNginxSite(site);
    if (!valid.ok) return valid;
    const result = await this.withTarget(targetId, (target) =>
      this.nginx.applySite(target, valid.value, renderManagedNginxSite(valid.value), onEvent),
    );
    if (result.ok)
      this.audit('nginx.site.saved', `Saved Nginx site ${site.domain}`, targetId, {
        domain: site.domain,
        backupId: result.value.backupId,
      });
    return result;
  }

  async removeSite(
    targetId: string,
    domain: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, NginxServiceError>> {
    const validDomain = normalizeDomain(domain);
    if (!validDomain.ok) return validDomain;
    const result = await this.withTarget(targetId, (target) =>
      this.nginx.removeSite(target, validDomain.value, onEvent),
    );
    if (result.ok)
      this.audit('nginx.site.deleted', `Deleted Nginx site ${validDomain.value}`, targetId, {
        domain: validDomain.value,
        backupId: result.value.backupId,
      });
    return result;
  }

  readMainConfig(targetId: string): Promise<Result<string, NginxServiceError>> {
    return this.withTarget(targetId, (target) => this.nginx.readMainConfig(target));
  }

  async saveMainConfig(
    targetId: string,
    content: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, NginxServiceError>> {
    if (!content.trim() || content.length > 2_000_000)
      return Promise.resolve(
        err(new ValidationError('Nginx configuration must be 1–2,000,000 characters')),
      );
    const result = await this.withTarget(targetId, (target) =>
      this.nginx.saveMainConfig(target, content, onEvent),
    );
    if (result.ok)
      this.audit('nginx.config.saved', 'Saved the Nginx main configuration', targetId, {
        backupId: result.value.backupId,
      });
    return result;
  }

  async reload(
    targetId: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, NginxServiceError>> {
    const result = await this.withTarget(targetId, (target) => this.nginx.reload(target, onEvent));
    this.audit(
      result.ok ? 'nginx.reload.succeeded' : 'nginx.reload.failed',
      result.ok ? 'Reloaded Nginx' : 'Nginx reload failed',
      targetId,
    );
    return result;
  }

  liveStatus(targetId: string): Promise<Result<NginxLiveStatus, NginxServiceError>> {
    return this.withTarget(targetId, (target) => this.nginx.liveStatus(target));
  }

  readLogs(targetId: string, query: NginxLogQuery): Promise<Result<string[], NginxServiceError>> {
    const limit = Math.min(Math.max(query.limit ?? 300, 1), 5_000);
    return this.withTarget(targetId, (target) => this.nginx.readLogs(target, { ...query, limit }));
  }

  listBackups(targetId: string): Promise<Result<NginxBackup[], NginxServiceError>> {
    return this.withTarget(targetId, (target) => this.nginx.listBackups(target));
  }

  readBackupConfig(targetId: string, backupId: string): Promise<Result<string, NginxServiceError>> {
    if (!/^[a-zA-Z0-9._-]+$/.test(backupId))
      return Promise.resolve(err(new ValidationError('Invalid backup identifier')));
    return this.withTarget(targetId, (target) => this.nginx.readBackupConfig(target, backupId));
  }

  async restore(
    targetId: string,
    backupId: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, NginxServiceError>> {
    if (!/^[a-zA-Z0-9._-]+$/.test(backupId))
      return err(new ValidationError('Invalid backup identifier'));
    const result = await this.withTarget(targetId, (target) =>
      this.nginx.restore(target, backupId, onEvent),
    );
    if (result.ok)
      this.audit('nginx.rollback', `Restored Nginx backup ${backupId}`, targetId, { backupId });
    return result;
  }

  private async withTarget<T>(
    targetId: string,
    action: (target: DeploymentTarget) => Promise<Result<T, DeploymentError>>,
  ): Promise<Result<T, NginxServiceError>> {
    if (!targetId.trim()) return err(new ValidationError('Select a VPS target'));
    const resolved = await this.targets.resolve(targetId);
    return resolved.ok ? action(resolved.value) : resolved;
  }

  private audit(
    type: string,
    message: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): void {
    this.activities.recordSafe({ type, message, metadata: { targetId, ...metadata } });
  }
}

const DOMAIN = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const HOST = /^(?:localhost|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|\[[0-9a-f:]+\])$/i;
const SIZE = /^\d+(?:k|m|g)?$/i;

function normalizeDomain(domain: string): Result<string, ValidationError> {
  const value = domain.trim().toLowerCase();
  return DOMAIN.test(value)
    ? ok(value)
    : err(new ValidationError('Enter a valid domain, subdomain, or wildcard domain'));
}

export function validateManagedNginxSite(
  site: ManagedNginxSite,
): Result<ManagedNginxSite, ValidationError> {
  const domain = normalizeDomain(site.domain);
  if (!domain.ok) return domain;
  const upstreamHost = site.upstreamHost.trim();
  if (!HOST.test(upstreamHost))
    return err(
      new ValidationError(
        'Enter a valid upstream hostname, IP address, localhost, or container name',
      ),
    );
  if (!Number.isInteger(site.upstreamPort) || site.upstreamPort < 1 || site.upstreamPort > 65_535)
    return err(new ValidationError('Upstream port must be 1–65535'));
  if (
    !Number.isInteger(site.proxyTimeoutSeconds) ||
    site.proxyTimeoutSeconds < 1 ||
    site.proxyTimeoutSeconds > 86_400
  )
    return err(new ValidationError('Proxy timeout must be 1–86400 seconds'));
  if (!SIZE.test(site.clientMaxBodySize))
    return err(new ValidationError('Client body size must look like 10m, 512k, or 1g'));
  if (
    site.certificatePath &&
    (!site.certificatePath.startsWith('/') || /[\r\n\0]/.test(site.certificatePath))
  )
    return err(new ValidationError('Certificate path must be an absolute remote path'));
  if (site.acmeWebroot && (!site.acmeWebroot.startsWith('/') || /[\r\n\0]/.test(site.acmeWebroot)))
    return err(new ValidationError('ACME webroot must be an absolute remote path'));
  const unsafe = [
    ...site.extraDirectives,
    ...site.customSnippets,
    ...site.locations.flatMap((location) => location.extraDirectives ?? []),
  ].find((line) => /[\r\n{}]/.test(line));
  if (unsafe)
    return err(
      new ValidationError(
        'Custom directives must contain one directive per field without braces or newlines',
      ),
    );
  for (const header of site.headers) {
    if (!/^[A-Za-z0-9-]+$/.test(header.name) || /[;{}\r\n]/.test(header.value))
      return err(new ValidationError('A proxy header is invalid'));
  }
  for (const location of site.locations) {
    if (!location.path.startsWith('/') || /[\r\n{}]/.test(location.path))
      return err(new ValidationError('Location paths must start with /'));
    if (location.upstreamHost && !HOST.test(location.upstreamHost))
      return err(new ValidationError('A location upstream host is invalid'));
    if (
      location.upstreamPort !== undefined &&
      (!Number.isInteger(location.upstreamPort) ||
        location.upstreamPort < 1 ||
        location.upstreamPort > 65_535)
    )
      return err(new ValidationError('A location upstream port must be 1–65535'));
  }
  return ok({
    ...site,
    domain: domain.value,
    upstreamHost,
    clientMaxBodySize: site.clientMaxBodySize.toLowerCase(),
  });
}

export function renderManagedNginxSite(site: ManagedNginxSite): string {
  const lines = [
    '# Managed by CloudForge. Manual changes may be replaced.',
    `# cloudforge-site: ${Buffer.from(JSON.stringify(site), 'utf8').toString('base64')}`,
    'server {',
    `  listen 80;`,
    `  server_name ${site.domain};`,
    `  client_max_body_size ${site.clientMaxBodySize};`,
  ];
  if (site.acmeWebroot)
    lines.push(
      '  location ^~ /.well-known/acme-challenge/ {',
      `    root ${site.acmeWebroot};`,
      '    default_type text/plain;',
      '  }',
    );
  if (site.httpRedirect && site.ssl)
    lines.push('  location / {', '    return 301 https://$host$request_uri;', '  }');
  else {
    lines.push(
      '  location / {',
      `    proxy_pass http://${site.upstreamHost}:${site.upstreamPort};`,
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Real-IP $remote_addr;',
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
      `    proxy_connect_timeout ${site.proxyTimeoutSeconds}s;`,
      `    proxy_read_timeout ${site.proxyTimeoutSeconds}s;`,
    );
    for (const header of site.headers)
      lines.push(`    proxy_set_header ${header.name} ${header.value};`);
    if (site.websocket)
      lines.push(
        '    proxy_http_version 1.1;',
        '    proxy_set_header Upgrade $http_upgrade;',
        '    proxy_set_header Connection "upgrade";',
      );
    if (site.cache) lines.push('    proxy_cache_bypass $http_upgrade;');
    for (const directive of site.extraDirectives) lines.push(`    ${terminate(directive)}`);
    lines.push('  }');
    for (const location of site.locations) {
      lines.push(`  location ${location.path} {`);
      if (location.upstreamHost && location.upstreamPort)
        lines.push(`    proxy_pass http://${location.upstreamHost}:${location.upstreamPort};`);
      for (const directive of location.extraDirectives ?? [])
        lines.push(`    ${terminate(directive)}`);
      lines.push('  }');
    }
    if (site.compression)
      lines.push(
        '  gzip on;',
        '  gzip_types text/plain text/css application/json application/javascript application/xml;',
      );
    for (const snippet of site.customSnippets) lines.push(`  ${terminate(snippet)}`);
  }
  lines.push('}', '');
  if (site.ssl) {
    const certificatePath = site.certificatePath ?? `/etc/letsencrypt/live/${site.domain}`;
    lines.push(
      'server {',
      '  listen 443 ssl http2;',
      `  server_name ${site.domain};`,
      `  ssl_certificate ${certificatePath}/fullchain.pem;`,
      `  ssl_certificate_key ${certificatePath}/privkey.pem;`,
      `  client_max_body_size ${site.clientMaxBodySize};`,
      '  location / {',
      `    proxy_pass http://${site.upstreamHost}:${site.upstreamPort};`,
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Real-IP $remote_addr;',
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
    );
    if (site.websocket)
      lines.push(
        '    proxy_http_version 1.1;',
        '    proxy_set_header Upgrade $http_upgrade;',
        '    proxy_set_header Connection "upgrade";',
      );
    lines.push('  }', '}', '');
  }
  return lines.join('\n');
}

function terminate(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}
