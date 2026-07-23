import { err, ok, type DeploymentError, type Result, ValidationError } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  ManagedNginxSite,
  NginxBackup,
  NginxEventSink,
  NginxHeader,
  NginxLiveStatus,
  NginxLocation,
  NginxLogQuery,
  NginxManager,
  NginxOperationOutcome,
  NginxOverview,
} from '../ports/nginx-manager.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type {
  RuntimeRouteSync,
  RuntimeTopologySynchronizer,
  RuntimeTopologySyncError,
} from '../ports/runtime-topology-synchronizer.js';

export type NginxServiceError = ValidationError | DeploymentError | RuntimeTopologySyncError;

export class NginxService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly nginx: NginxManager,
    private readonly activities: ActivityService,
    private readonly runtime?: RuntimeTopologySynchronizer,
  ) {}

  inspect(targetId: string): Promise<Result<NginxOverview, NginxServiceError>> {
    return this.withTarget(targetId, (target) => this.nginx.inspect(target));
  }

  async listSites(targetId: string): Promise<Result<ManagedNginxSite[], NginxServiceError>> {
    const sites = await this.withTarget(targetId, (target) => this.nginx.listSites(target));
    if (!sites.ok || !this.runtime) return sites;
    const synchronized = await this.runtime.replaceRoutes(targetId, runtimeRoutes(sites.value));
    return synchronized.ok ? sites : synchronized;
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
    if (result.ok) {
      const synchronized = await this.synchronizeRoutes(targetId);
      if (!synchronized.ok) return synchronized;
      this.audit('nginx.site.saved', `Saved Nginx site ${site.domain}`, targetId, {
        domain: site.domain,
        backupId: result.value.backupId,
      });
    }
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
    if (result.ok) {
      const synchronized = await this.synchronizeRoutes(targetId);
      if (!synchronized.ok) return synchronized;
      this.audit('nginx.site.deleted', `Deleted Nginx site ${validDomain.value}`, targetId, {
        domain: validDomain.value,
        backupId: result.value.backupId,
      });
    }
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
    if (result.ok) {
      const synchronized = await this.synchronizeRoutes(targetId);
      if (!synchronized.ok) return synchronized;
      this.audit('nginx.config.saved', 'Saved the Nginx main configuration', targetId, {
        backupId: result.value.backupId,
      });
    }
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
    if (result.ok) {
      const synchronized = await this.synchronizeRoutes(targetId);
      if (!synchronized.ok) return synchronized;
      this.audit('nginx.rollback', `Restored Nginx backup ${backupId}`, targetId, { backupId });
    }
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

  private async synchronizeRoutes(targetId: string): Promise<Result<void, NginxServiceError>> {
    if (!this.runtime) return ok(undefined);
    const sites = await this.withTarget(targetId, (target) => this.nginx.listSites(target));
    if (!sites.ok) return sites;
    return this.runtime.replaceRoutes(targetId, runtimeRoutes(sites.value));
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

function runtimeRoutes(sites: readonly ManagedNginxSite[]): RuntimeRouteSync[] {
  return sites
    .filter((site) => site.managed === true)
    .flatMap((site) => {
      const siteId = site.configPath ?? site.domain;
      const root: RuntimeRouteSync = {
        sourceId: `${siteId}:/`,
        domain: site.domain,
        path: '/',
        upstreamHost: site.upstreamHost,
        upstreamPort: site.upstreamPort,
        websocket: site.websocket,
        tls: site.ssl,
        httpRedirect: site.httpRedirect,
        ownership: 'cloudforge-managed',
      };
      return [
        root,
        ...site.locations.map((location): RuntimeRouteSync => ({
          sourceId: `${siteId}:${location.path}`,
          domain: site.domain,
          path: location.path,
          upstreamHost: location.upstreamHost ?? site.upstreamHost,
          upstreamPort: location.upstreamPort ?? site.upstreamPort,
          websocket: location.websocket ?? site.websocket,
          tls: site.ssl,
          httpRedirect: site.httpRedirect,
          ownership: 'cloudforge-managed',
        })),
      ];
    });
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
    if (
      location.proxyTimeoutSeconds !== undefined &&
      (!Number.isInteger(location.proxyTimeoutSeconds) ||
        location.proxyTimeoutSeconds < 1 ||
        location.proxyTimeoutSeconds > 86_400)
    )
      return err(new ValidationError('A location proxy timeout must be 1–86400 seconds'));
  }
  return ok({
    ...site,
    domain: domain.value,
    upstreamHost,
    // Derived, never trusted from the caller. `upstreamKind` answers "can a
    // proxy that is not on a Docker network resolve this?", and the only
    // evidence for that is the host itself. A stored value that disagreed with
    // the host would be worse than no value: everything downstream would
    // believe it.
    upstreamKind: inferUpstreamKind(upstreamHost),
    clientMaxBodySize: site.clientMaxBodySize.toLowerCase(),
  });
}

/**
 * Marker prefixing the encoded site model in every generated config file.
 *
 * A CloudForge-owned site file carries its own model, because there is no local
 * table of sites — the file on the VPS is the record. Readers grep for this
 * marker to tell an owned site from a hand-written one.
 */
export const NGINX_SITE_MARKER = '# cloudforge-site: ';

/**
 * Version stamped into the encoded model.
 *
 * The stamp sits alongside the site's own fields rather than wrapping them, so
 * an older CloudForge reading a newer file still sees a plain site object and
 * ignores the extra key. Files written before versioning have no stamp and are
 * read as version 0.
 */
export const NGINX_SITE_SCHEMA_VERSION = 1;

/** Fields the adapter derives per read; never part of the desired configuration. */
type PersistedSite = Omit<ManagedNginxSite, 'managed' | 'configPath'>;

function encodedSite(site: ManagedNginxSite): PersistedSite {
  const { managed: _managed, configPath: _configPath, ...persisted } = site;
  return persisted;
}

export function encodeManagedNginxSite(site: ManagedNginxSite): string {
  const payload = { schemaVersion: NGINX_SITE_SCHEMA_VERSION, ...encodedSite(site) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function headerList(value: unknown): NginxHeader[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    return typeof raw.name === 'string' && typeof raw.value === 'string'
      ? [{ name: raw.name, value: raw.value }]
      : [];
  });
}

function locationList(value: unknown): NginxLocation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.path !== 'string') return [];
    return [
      {
        path: raw.path,
        ...(typeof raw.upstreamHost === 'string' ? { upstreamHost: raw.upstreamHost } : {}),
        ...(typeof raw.upstreamPort === 'number' ? { upstreamPort: raw.upstreamPort } : {}),
        ...(Array.isArray(raw.extraDirectives)
          ? { extraDirectives: stringList(raw.extraDirectives) }
          : {}),
      },
    ];
  });
}

/**
 * Rebuild a site model from an encoded comment, defaulting every absent field.
 *
 * Defaulting on read — rather than trusting the parse — is what lets the model
 * gain fields without invalidating sites already deployed on a VPS. An
 * unreadable or domain-less payload yields null so the caller can fall back to
 * treating the file as unmanaged rather than acting on a half-built model.
 */
export function decodeManagedNginxSite(encoded: string): ManagedNginxSite | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const domain = typeof raw.domain === 'string' ? raw.domain.trim().toLowerCase() : '';
  if (!domain) return null;
  return {
    domain,
    enabled: boolOr(raw.enabled, true),
    upstreamKind: raw.upstreamKind === 'docker' ? 'docker' : 'host',
    upstreamHost: stringOr(raw.upstreamHost, '127.0.0.1'),
    upstreamPort: intOr(raw.upstreamPort, 80),
    websocket: boolOr(raw.websocket, false),
    ssl: boolOr(raw.ssl, false),
    ...(typeof raw.certificatePath === 'string' ? { certificatePath: raw.certificatePath } : {}),
    ...(typeof raw.acmeWebroot === 'string' ? { acmeWebroot: raw.acmeWebroot } : {}),
    httpRedirect: boolOr(raw.httpRedirect, false),
    headers: headerList(raw.headers),
    extraDirectives: stringList(raw.extraDirectives),
    locations: locationList(raw.locations),
    proxyTimeoutSeconds: intOr(raw.proxyTimeoutSeconds, 60),
    clientMaxBodySize: stringOr(raw.clientMaxBodySize, '10m'),
    compression: boolOr(raw.compression, true),
    cache: boolOr(raw.cache, false),
    customSnippets: stringList(raw.customSnippets),
    lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : null,
  };
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Classify an upstream by its address.
 *
 * A Docker network alias resolves only inside a Docker network, so it is
 * categorically different from a host address even though both are just a
 * hostname here — nginx running on the host cannot resolve one at all, because
 * the host's resolver does not answer Docker DNS. Loopback names, IP literals
 * and dotted names address the host or the wider network; a bare single-label
 * name is only meaningful as a container.
 *
 * The single source of this judgement, for both owned and hand-written sites.
 * Owned sites used to carry a stored `upstreamKind` that nothing derived and
 * nothing checked, so it could disagree with the host it described.
 */
export function inferUpstreamKind(upstreamHost: string): 'host' | 'docker' {
  const host = upstreamHost.trim().toLowerCase();
  if (!host || host === 'localhost' || host.startsWith('[')) return 'host';
  if (IPV4.test(host) || host.includes(':')) return 'host';
  return host.includes('.') ? 'host' : 'docker';
}

/**
 * Everything a server block proxies: `/`, every additional route, compression
 * and custom snippets.
 *
 * Shared by the HTTP and HTTPS blocks. They were previously written out
 * separately and had drifted: the HTTPS copy omitted routes, headers, timeouts,
 * compression and snippets, so enabling TLS silently dropped every additional
 * route a site declared.
 */
function proxyBodyLines(site: ManagedNginxSite): string[] {
  const lines: string[] = [];
  appendMainProxyLocation(lines, site);
  appendAdditionalLocations(lines, site);
  if (site.compression)
    lines.push(
      '  gzip on;',
      '  gzip_types text/plain text/css application/json application/javascript application/xml;',
    );
  for (const snippet of site.customSnippets) lines.push(`  ${terminate(snippet)}`);
  return lines;
}

export function renderManagedNginxSite(site: ManagedNginxSite): string {
  const lines = [
    '# Managed by CloudForge. Manual changes may be replaced.',
    `${NGINX_SITE_MARKER}${encodeManagedNginxSite(site)}`,
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
  else lines.push(...proxyBodyLines(site));
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
      ...proxyBodyLines(site),
      '}',
      '',
    );
  }
  return lines.join('\n');
}

function appendMainProxyLocation(lines: string[], site: ManagedNginxSite): void {
  appendProxyLocation(lines, {
    path: '/',
    upstreamHost: site.upstreamHost,
    upstreamPort: site.upstreamPort,
    websocket: site.websocket,
    proxyTimeoutSeconds: site.proxyTimeoutSeconds,
    extraDirectives: [
      ...site.headers.map((header) => `proxy_set_header ${header.name} ${header.value}`),
      ...(site.cache ? ['proxy_cache_bypass $http_upgrade'] : []),
      ...site.extraDirectives,
    ],
  });
}

function appendAdditionalLocations(lines: string[], site: ManagedNginxSite): void {
  for (const location of site.locations) appendProxyLocation(lines, location);
}

function appendProxyLocation(lines: string[], location: NginxLocation): void {
  lines.push(`  location ${location.path} {`);
  if (location.upstreamHost && location.upstreamPort)
    lines.push(`    proxy_pass http://${location.upstreamHost}:${location.upstreamPort};`);
  lines.push(
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
  );
  const timeout = location.proxyTimeoutSeconds;
  if (timeout) lines.push(`    proxy_connect_timeout ${timeout}s;`);
  if (location.websocket) {
    lines.push(
      '    proxy_http_version 1.1;',
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection "upgrade";',
      `    proxy_read_timeout ${timeout ?? 3_600}s;`,
    );
  } else if (timeout) lines.push(`    proxy_read_timeout ${timeout}s;`);
  for (const directive of location.extraDirectives ?? []) lines.push(`    ${terminate(directive)}`);
  lines.push('  }');
}

function terminate(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}
