import {
  ConflictError,
  DeploymentError,
  err,
  ok,
  ValidationError,
  type Result,
} from '@cloudforge/shared';
import type { NginxService } from '../nginx/nginx-service.js';
import type {
  CertificateDetails,
  CertificateEventSink,
  CertificateIssueConfig,
  DomainResolver,
  ManagedDnsCoordinator,
} from '../ports/certificate-manager.js';
import type { ManagedNginxSite } from '../ports/nginx-manager.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type { CloudflareService } from '../service-providers/cloudflare-service.js';

/** Same locations the SSL page uses, so certificates renew with the rest. */
export const DOMAIN_CERTIFICATE_VOLUME = '/opt/cloudforge/certs';
export const DOMAIN_WEBROOT_VOLUME = '/opt/cloudforge/www';

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME']);

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function isValidDomain(value: string): boolean {
  return DOMAIN.test(value);
}

function isIpAddress(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}

export interface DomainQuery {
  readonly targetId: string;
  readonly domain: string;
  readonly cloudflareCredentialId?: string | null;
  readonly cloudflareZoneId?: string | null;
}

export interface DomainCheck {
  readonly domain: string;
  /** False when anything else already uses the domain; the reasons are in `conflicts`. */
  readonly available: boolean;
  readonly conflicts: readonly string[];
  /** Facts that do not block, e.g. DNS already pointing to this server. */
  readonly notes: readonly string[];
}

/** CloudForge applications that publish a domain: pipelines, WordPress sites, stacks. */
export interface DomainOwners {
  owners(domain: string): Promise<Result<readonly string[], unknown>>;
}

/** The part of SslService needed here: issue a certificate and switch Nginx to HTTPS. */
export interface DomainCertificateIssuer {
  issue(
    targetId: string,
    config: CertificateIssueConfig,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, unknown>>;
  forget?(targetId: string, domain: string): Promise<void>;
}

export interface DomainEvent {
  readonly stream: 'step' | 'stdout' | 'stderr' | 'error';
  readonly message: string;
}
export type DomainEventSink = (event: DomainEvent) => void;

/** One domain in front of one local port. */
export interface PublishedDomain {
  readonly targetId: string;
  readonly domain: string;
  /** The application listens on 127.0.0.1:hostPort; Nginx publishes it. */
  readonly hostPort: number;
  readonly cloudflareCredentialId: string | null;
  readonly cloudflareZoneId: string | null;
  /** Orange cloud or DNS only for a new record; null follows the Cloudflare settings. */
  readonly proxied?: boolean | null;
  readonly https: boolean;
  readonly certificateEmail: string | null;
  readonly clientMaxBodySize: string;
  readonly proxyTimeoutSeconds: number;
  readonly websocket: boolean;
}

export type DomainPublisherError = ValidationError | ConflictError | DeploymentError;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * What every application published on a domain shares: refuse a domain that is
 * already used, create the Cloudflare record, write the Nginx site and handle
 * HTTPS. WordPress sites and Docker stacks differ only in what runs behind the
 * local port.
 */
export class DomainPublisher {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly nginx?: Pick<NginxService, 'listSites' | 'saveSite' | 'removeSite'>,
    private readonly managedDns?: ManagedDnsCoordinator,
    private readonly certificates?: DomainCertificateIssuer,
    private readonly cloudflare?: Pick<CloudflareService, 'dnsRecords'>,
    private readonly domainOwners?: DomainOwners,
    private readonly dns?: DomainResolver,
  ) {}

  /**
   * Whether a domain is free. It is taken when a CloudForge application uses it,
   * when Nginx on the server already serves it, or when its Cloudflare record
   * points somewhere other than this server. A record that already points here
   * is fine; a domain that could not be checked counts as taken.
   */
  async check(query: DomainQuery): Promise<Result<DomainCheck, DomainPublisherError>> {
    const domain = normalizeDomain(query.domain);
    if (!isValidDomain(domain))
      return err(new ValidationError('Enter a domain name such as app.example.com'));
    const conflicts: string[] = [];
    const notes: string[] = [];

    if (this.domainOwners) {
      const owners = await this.domainOwners.owners(domain);
      if (!owners.ok) conflicts.push('Could not check the other CloudForge applications.');
      else for (const owner of owners.value) conflicts.push(`${owner} already uses ${domain}.`);
    }

    const target = await this.targets.resolve(query.targetId);
    if (!target.ok) return target;

    if (this.nginx) {
      const sites = await this.nginx.listSites(query.targetId);
      if (!sites.ok) {
        conflicts.push(`Could not read the Nginx sites on the server: ${sites.error.message}`);
      } else {
        const served = sites.value.find((site) => site.domain.toLowerCase() === domain);
        if (served)
          conflicts.push(
            served.managed === false
              ? `Nginx on this server already serves ${domain} (configured outside CloudForge).`
              : `Nginx on this server already serves ${domain}.`,
          );
      }
    }

    const credentialId = query.cloudflareCredentialId?.trim();
    const zoneId = query.cloudflareZoneId?.trim();
    if (this.cloudflare && credentialId && zoneId) {
      const records = await this.cloudflare.dnsRecords(credentialId, zoneId);
      if (!records.ok) {
        conflicts.push(`Could not read the Cloudflare DNS records: ${records.error.message}`);
      } else {
        const addresses = await this.addresses(target.value.host);
        for (const record of records.value) {
          if (normalizeDomain(record.name) !== domain || !ADDRESS_RECORD_TYPES.has(record.type))
            continue;
          if (record.type === 'CNAME')
            conflicts.push(`Cloudflare DNS sends ${domain} to ${record.content} (CNAME).`);
          else if (!addresses.includes(record.content))
            conflicts.push(
              `Cloudflare DNS points ${domain} to ${record.content}, another server or service.`,
            );
          else notes.push(`Cloudflare DNS already points ${domain} to this server.`);
        }
        if (notes.length === 0)
          notes.push(`No DNS record yet: CloudForge will create it in Cloudflare.`);
      }
    }

    return ok({ domain, available: conflicts.length === 0, conflicts, notes });
  }

  /**
   * Run DNS, Nginx and HTTPS for one domain. Safe to run again. Only a problem
   * that leaves the domain unpublished is an error; DNS still propagating or a
   * certificate that could not be issued yet come back as warnings to act on.
   */
  async publish(
    route: PublishedDomain,
    onEvent?: DomainEventSink,
  ): Promise<Result<{ warnings: string[] }, DomainPublisherError>> {
    const step = (message: string): void => onEvent?.({ stream: 'step', message });
    const target = await this.targets.resolve(route.targetId);
    if (!target.ok) return target;
    const warnings: string[] = [];

    let dnsReady = !route.cloudflareCredentialId;
    let proxied = false;
    let sslMode = 'unknown';
    if (route.cloudflareCredentialId) {
      if (!this.managedDns) {
        warnings.push(
          `Cloudflare automation is not available, so DNS for ${route.domain} was not created.`,
        );
      } else {
        const address = (await this.addresses(target.value.host))[0];
        if (!address) {
          warnings.push(`The server address ${target.value.host} could not be resolved for DNS.`);
        } else {
          step(`Pointing ${route.domain} to ${address} in Cloudflare`);
          const dns = await this.managedDns.ensure(
            route.domain,
            address,
            route.cloudflareCredentialId,
            route.cloudflareZoneId ?? undefined,
            typeof route.proxied === 'boolean' ? { proxied: route.proxied } : {},
          );
          if (!dns.ok) {
            warnings.push(`Cloudflare DNS for ${route.domain} failed: ${detail(dns.error)}`);
          } else {
            proxied = dns.value.proxied === true;
            sslMode = dns.value.sslMode ?? 'unknown';
            if (dns.value.status === 'propagated') {
              dnsReady = true;
              // On a propagated record this text only describes the proxy; it is not a problem.
              if (dns.value.warning) onEvent?.({ stream: 'stdout', message: dns.value.warning });
            } else {
              warnings.push(
                dns.value.warning ??
                  `DNS for ${route.domain} has not propagated yet. Redeploy in a few minutes to enable HTTPS.`,
              );
            }
          }
        }
      }
    }

    if (!this.nginx) {
      warnings.push(`Nginx automation is not available, so ${route.domain} was not published.`);
      return ok({ warnings });
    }
    step(`Publishing ${route.domain} with Nginx`);
    const site = await this.writeSite(route);
    if (!site.ok) return site;

    if (route.https) {
      if (site.value.ssl) {
        // A new Origin certificate on every redeploy would pile up in Cloudflare;
        // Let's Encrypt certificates renew on their own schedule.
        step(`HTTPS is already configured for ${route.domain}`);
      } else if (!this.certificates) {
        warnings.push(`Certificate automation is not available, so ${route.domain} has no HTTPS.`);
      } else if (!dnsReady) {
        warnings.push(`HTTPS for ${route.domain} waits for DNS. Redeploy once DNS is ready.`);
      } else {
        const failure = await this.secure(route, proxied, sslMode, onEvent);
        if (failure) warnings.push(failure);
      }
      if (proxied && (sslMode === 'flexible' || sslMode === 'off'))
        warnings.push(
          sslMode === 'off'
            ? `Cloudflare SSL is off for this zone, so ${route.domain} has no HTTPS for visitors. Enable it in Cloudflare.`
            : `This Cloudflare zone uses Flexible SSL, so traffic between Cloudflare and the server is not encrypted. CloudForge did not change it because other sites share the zone; use Full (strict) once they all have certificates.`,
        );
    }
    return ok({ warnings });
  }

  /**
   * Take a domain down. With `deleteDns` the Cloudflare record goes too, when
   * CloudForge created it; a record someone else made is never deleted.
   */
  async unpublish(
    route: Pick<
      PublishedDomain,
      'targetId' | 'domain' | 'cloudflareCredentialId' | 'cloudflareZoneId'
    >,
    options: { readonly deleteDns: boolean },
    onEvent?: DomainEventSink,
  ): Promise<Result<{ warnings: string[] }, DomainPublisherError>> {
    const warnings: string[] = [];
    if (this.nginx) {
      const sites = await this.nginx.listSites(route.targetId);
      const site = sites.ok
        ? sites.value.find((item) => item.domain === route.domain && item.managed !== false)
        : undefined;
      if (site) {
        onEvent?.({ stream: 'step', message: `Removing the Nginx site for ${route.domain}` });
        const removed = await this.nginx.removeSite(route.targetId, route.domain);
        if (!removed.ok)
          return err(
            new DeploymentError(`The Nginx site for ${route.domain} could not be removed`, {
              cause: removed.error,
            }),
          );
      }
    }
    await this.certificates?.forget?.(route.targetId, route.domain);
    if (options.deleteDns && route.cloudflareCredentialId && this.managedDns?.withdraw) {
      const target = await this.targets.resolve(route.targetId);
      if (!target.ok) return target;
      const address = (await this.addresses(target.value.host))[0];
      if (address) {
        const withdrawn = await this.managedDns.withdraw(
          route.domain,
          address,
          route.cloudflareCredentialId,
          route.cloudflareZoneId ?? undefined,
        );
        if (!withdrawn.ok)
          warnings.push(
            `The DNS record of ${route.domain} could not be deleted: ${detail(withdrawn.error)}`,
          );
        else if (withdrawn.value.removed)
          onEvent?.({ stream: 'step', message: `Deleted the DNS record of ${route.domain}` });
      }
    }
    return ok({ warnings });
  }

  /**
   * Issue the certificate that fits how visitors reach the server, and return
   * what went wrong if none could be issued.
   *
   * Behind the Cloudflare proxy an Origin certificate is the right tool: it needs
   * nothing reachable from the internet and never expires in practice. The zone's
   * SSL mode stays as it is, because it is shared with the other sites of the
   * domain. A token without the Origin CA permission falls back to Let's Encrypt.
   */
  private async secure(
    route: PublishedDomain,
    proxied: boolean,
    sslMode: string,
    onEvent?: DomainEventSink,
  ): Promise<string | null> {
    const step = (message: string): void => onEvent?.({ stream: 'step', message });
    const sink: CertificateEventSink = (event) => onEvent?.(event);
    // In Flexible mode Cloudflare reaches the server over HTTP, so a redirect to
    // HTTPS here would send every visitor round in an endless loop.
    const httpRedirect = !proxied || sslMode === 'full' || sslMode === 'strict';
    const common = {
      domain: route.domain,
      email: route.certificateEmail ?? '',
      certificateVolume: DOMAIN_CERTIFICATE_VOLUME,
      webrootVolume: DOMAIN_WEBROOT_VOLUME,
      forceRenewal: false,
      httpRedirect,
      ...(route.cloudflareCredentialId
        ? { cloudflareCredentialId: route.cloudflareCredentialId }
        : {}),
    };
    let originFailure: string | null = null;
    if (proxied && route.cloudflareCredentialId && this.certificates) {
      step(`Requesting a Cloudflare Origin certificate for ${route.domain}`);
      const origin = await this.certificates.issue(
        route.targetId,
        {
          ...common,
          authority: 'cloudflare-origin-ca',
          keyAlgorithm: 'ecc',
          validityDays: 5475,
          keepCloudflareSslMode: true,
        },
        sink,
      );
      if (origin.ok) return null;
      originFailure = detail(origin.error);
      step(`Cloudflare Origin certificate not available (${originFailure}); trying Let's Encrypt`);
    }
    if (!route.certificateEmail)
      return `HTTPS for ${route.domain} needs a certificate email for Let's Encrypt.${originFailure ? ` Origin certificate: ${originFailure}` : ''}`;
    step(`Requesting a Let's Encrypt certificate for ${route.domain}`);
    const issued = await this.certificates?.issue(
      route.targetId,
      { ...common, authority: 'letsencrypt' },
      sink,
    );
    if (issued?.ok) return null;
    const failure = issued ? detail(issued.error) : 'certificate automation is not available';
    return `HTTPS is not enabled for ${route.domain} yet: ${failure}.${
      originFailure
        ? ` The Cloudflare Origin certificate also failed: ${originFailure} (the token needs Zone → SSL and Certificates → Edit).`
        : ''
    } Fix the cause, then use Redeploy.`;
  }

  /** Point the domain at the local port, keeping any HTTPS already set up. */
  private async writeSite(
    route: PublishedDomain,
  ): Promise<Result<ManagedNginxSite, DomainPublisherError>> {
    const nginx = this.nginx;
    if (!nginx) return err(new DeploymentError('Nginx automation is not available'));
    const sites = await nginx.listSites(route.targetId);
    if (!sites.ok)
      return err(new DeploymentError('Could not read the Nginx sites', { cause: sites.error }));
    const existing = sites.value.find((item) => item.domain.toLowerCase() === route.domain);
    if (existing?.managed === false)
      return err(
        new ConflictError(
          `${route.domain} already has an Nginx site that CloudForge does not manage. Remove it or use another domain.`,
        ),
      );
    // Our own site proxies to this port; any other port is another application.
    if (existing && existing.upstreamPort !== route.hostPort)
      return err(
        new ConflictError(
          `Nginx already serves ${route.domain} for another application (port ${String(existing.upstreamPort)}).`,
        ),
      );
    const upstream = {
      enabled: true,
      upstreamKind: 'host' as const,
      upstreamHost: '127.0.0.1',
      upstreamPort: route.hostPort,
      websocket: route.websocket,
      locations: [],
      proxyTimeoutSeconds: route.proxyTimeoutSeconds,
      clientMaxBodySize: route.clientMaxBodySize,
      lastModified: new Date().toISOString(),
    };
    const next: ManagedNginxSite = existing
      ? { ...existing, ...upstream }
      : {
          domain: route.domain,
          ...upstream,
          ssl: false,
          httpRedirect: false,
          headers: [],
          extraDirectives: [],
          compression: true,
          cache: false,
          customSnippets: [],
        };
    const saved = await nginx.saveSite(route.targetId, next);
    if (!saved.ok)
      return err(
        new DeploymentError(`Nginx could not publish ${route.domain}: ${saved.error.message}`, {
          cause: saved.error,
        }),
      );
    return ok(next);
  }

  /** The server's addresses: itself when it is an IP, otherwise what its name resolves to. */
  private async addresses(host: string): Promise<readonly string[]> {
    if (isIpAddress(host) || !this.dns) return [host];
    const resolved = await this.dns.resolve(host);
    return resolved.ok ? resolved.value : [];
  }
}
