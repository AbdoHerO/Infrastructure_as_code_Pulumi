import {
  ConflictError,
  DeploymentError,
  err,
  newUuid,
  NotFoundError,
  ok,
  ValidationError,
  type PersistenceError,
  type Result,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  CredentialService,
  CredentialServiceError,
} from '../credentials/credential-service.js';
import type { NginxService } from '../nginx/nginx-service.js';
import type {
  CertificateDetails,
  CertificateEventSink,
  CertificateIssueConfig,
  ManagedDnsCoordinator,
} from '../ports/certificate-manager.js';
import type { ManagedNginxSite } from '../ports/nginx-manager.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type { CloudflareService } from '../service-providers/cloudflare-service.js';
import type {
  WordPressEventSink,
  WordPressManager,
  WordPressRuntimeStatus,
  WordPressSiteRecord,
  WordPressSiteStore,
} from '../ports/wordpress-manager.js';
import {
  generateWordPressSecret,
  nextWordPressPort,
  renderWordPressCompose,
  renderWordPressPhpIni,
  validateWordPressSite,
  wordpressProject,
  wordpressSiteUrl,
  type WordPressSiteInput,
} from './wordpress-site.js';

/** Same locations the SSL page uses, so certificates renew with the rest. */
export const WORDPRESS_CERTIFICATE_VOLUME = '/opt/cloudforge/certs';
export const WORDPRESS_WEBROOT_VOLUME = '/opt/cloudforge/www';

/** The part of SslService this feature needs: issue a certificate and switch Nginx to HTTPS. */
export interface WordPressCertificateIssuer {
  issue(
    targetId: string,
    config: CertificateIssueConfig,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, unknown>>;
}

export type WordPressServiceError =
  | ValidationError
  | NotFoundError
  | ConflictError
  | DeploymentError
  | PersistenceError
  | CredentialServiceError;

interface SiteSecrets {
  readonly databasePassword: string;
  readonly databaseRootPassword: string;
  readonly adminPassword: string;
}

export interface CreatedWordPressSite {
  readonly site: WordPressSiteRecord;
  /** Shown once after creation; it stays revealable in Secrets afterwards. */
  readonly adminPassword: string;
}

/** Other CloudForge applications that publish a domain, e.g. Jenkins pipelines. */
export interface WordPressDomainOwners {
  owners(domain: string): Promise<Result<readonly string[], unknown>>;
}

export interface WordPressDomainQuery {
  readonly targetId: string;
  readonly domain: string;
  readonly cloudflareCredentialId?: string | null;
  readonly cloudflareZoneId?: string | null;
}

export interface WordPressDomainCheck {
  readonly domain: string;
  /** False when anything else already uses the domain; the reasons are in `conflicts`. */
  readonly available: boolean;
  readonly conflicts: readonly string[];
  /** Facts that do not block, e.g. DNS already pointing to this server. */
  readonly notes: readonly string[];
}

const DOMAIN_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME']);

export class WordPressService {
  constructor(
    private readonly store: WordPressSiteStore,
    private readonly targets: RemoteTargetResolver,
    private readonly manager: WordPressManager,
    private readonly credentials: Pick<
      CredentialService,
      'create' | 'list' | 'getDecrypted' | 'remove'
    >,
    private readonly activities: Pick<ActivityService, 'recordSafe'>,
    private readonly nginx?: Pick<NginxService, 'listSites' | 'saveSite' | 'removeSite'>,
    private readonly managedDns?: ManagedDnsCoordinator,
    private readonly certificates?: WordPressCertificateIssuer,
    private readonly cloudflare?: Pick<CloudflareService, 'dnsRecords'>,
    private readonly otherApps?: WordPressDomainOwners,
  ) {}

  list(): Promise<Result<WordPressSiteRecord[], PersistenceError>> {
    return this.store.list();
  }

  /**
   * Whether a domain is free for a new site. It is taken when another WordPress
   * site or CloudForge application uses it, when Nginx on the server already
   * serves it, or when its Cloudflare record points somewhere other than this
   * server. A record that already points here is fine.
   */
  async checkDomain(
    query: WordPressDomainQuery,
  ): Promise<Result<WordPressDomainCheck, WordPressServiceError>> {
    const domain = query.domain.trim().toLowerCase().replace(/\.$/, '');
    const conflicts: string[] = [];
    const notes: string[] = [];

    const sites = await this.store.list();
    if (!sites.ok) return sites;
    const site = sites.value.find((item) => item.domain === domain);
    if (site) conflicts.push(`A WordPress site already uses ${domain}.`);

    if (this.otherApps) {
      const owners = await this.otherApps.owners(domain);
      if (!owners.ok) conflicts.push('Could not check the other CloudForge applications.');
      else for (const owner of owners.value) conflicts.push(`${owner} already uses ${domain}.`);
    }

    const target = await this.targets.resolve(query.targetId);
    if (!target.ok) return target;

    if (this.nginx) {
      const nginxSites = await this.nginx.listSites(query.targetId);
      if (!nginxSites.ok) {
        conflicts.push(`Could not read the Nginx sites on the server: ${nginxSites.error.message}`);
      } else {
        const served = nginxSites.value.find((item) => item.domain.toLowerCase() === domain);
        if (served && !site)
          conflicts.push(
            served.managed === false
              ? `Nginx on this server already serves ${domain} (configured outside CloudForge).`
              : `Nginx on this server already serves ${domain} for another application.`,
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
        for (const record of records.value) {
          if (record.name.toLowerCase() !== domain || !DOMAIN_RECORD_TYPES.has(record.type))
            continue;
          if (record.type === 'CNAME')
            conflicts.push(`Cloudflare DNS sends ${domain} to ${record.content} (CNAME).`);
          else if (record.content !== target.value.host)
            conflicts.push(
              `Cloudflare DNS points ${domain} to ${record.content}, another server or service.`,
            );
          else notes.push(`Cloudflare DNS already points ${domain} to this server.`);
        }
      }
    }

    return ok({ domain, available: conflicts.length === 0, conflicts, notes });
  }

  /**
   * Create a site and run every step: containers, DNS, Nginx, HTTPS. A failure
   * after the record exists keeps it (status `failed`) so Redeploy or Remove
   * can finish the job; nothing is left that CloudForge cannot see.
   */
  async create(
    input: WordPressSiteInput,
    onEvent?: WordPressEventSink,
  ): Promise<Result<CreatedWordPressSite, WordPressServiceError>> {
    const valid = validateWordPressSite(input);
    if (!valid.ok) return valid;
    const sites = await this.store.list();
    if (!sites.ok) return sites;
    const project = wordpressProject(valid.value.domain);
    if (sites.value.some((site) => site.domain === valid.value.domain || site.project === project))
      return err(new ConflictError(`A WordPress site for ${valid.value.domain} already exists`));
    const taken = sites.value
      .filter((site) => site.targetId === valid.value.targetId)
      .map((site) => site.hostPort);
    const hostPort = valid.value.hostPort ?? nextWordPressPort(taken);
    if (taken.includes(hostPort))
      return err(new ConflictError(`Port ${hostPort} is already used by another WordPress site`));
    const target = await this.targets.resolve(valid.value.targetId);
    if (!target.ok) return target;
    const domainCheck = await this.checkDomain(valid.value);
    if (!domainCheck.ok) return domainCheck;
    if (!domainCheck.value.available)
      return err(new ConflictError(domainCheck.value.conflicts.join(' ')));

    // Remove keeps the server data and this secret. Deploying the same domain again
    // must reuse them: the database volume and WordPress hold those passwords.
    const kept = await this.keptSecrets(valid.value.domain);
    if (!kept.ok) return kept;
    let credentialId: string;
    let secrets: SiteSecrets;
    let adminUser = valid.value.adminUser;
    if (kept.value) {
      credentialId = kept.value.credentialId;
      secrets = kept.value.secrets;
      adminUser = kept.value.adminUser ?? adminUser;
      onEvent?.({
        stream: 'step',
        message: `Reusing the passwords kept for ${valid.value.domain} in Secrets`,
      });
    } else {
      secrets = {
        databasePassword: generateWordPressSecret(32),
        databaseRootPassword: generateWordPressSecret(32),
        adminPassword: valid.value.adminPassword ?? generateWordPressSecret(20),
      };
      const credential = await this.credentials.create({
        kind: 'environment-file',
        name: secretName(valid.value.domain),
        data: {
          filename: `${project}.env`,
          content: [
            `WORDPRESS_URL=${wordpressSiteUrl(valid.value.domain, valid.value.https)}/wp-admin/`,
            `WORDPRESS_ADMIN_USER=${adminUser}`,
            `WORDPRESS_ADMIN_PASSWORD=${secrets.adminPassword}`,
            `DB_PASSWORD=${secrets.databasePassword}`,
            `DB_ROOT_PASSWORD=${secrets.databaseRootPassword}`,
            '',
          ].join('\n'),
        },
      });
      if (!credential.ok) return credential;
      credentialId = credential.value.id;
    }

    const now = new Date().toISOString();
    const record: WordPressSiteRecord = {
      id: newUuid(),
      targetId: valid.value.targetId,
      domain: valid.value.domain,
      project,
      siteTitle: valid.value.siteTitle,
      adminUser,
      adminEmail: valid.value.adminEmail,
      hostPort,
      credentialId,
      cloudflareCredentialId: valid.value.cloudflareCredentialId,
      cloudflareZoneId: valid.value.cloudflareZoneId,
      https: valid.value.https,
      certificateEmail: valid.value.certificateEmail,
      status: 'deploying',
      wordpressVersion: null,
      warnings: [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await this.store.save(record);
    if (!saved.ok) {
      if (!kept.value) await this.credentials.remove(credentialId);
      return saved;
    }
    const applied = await this.apply(record, secrets, onEvent);
    if (!applied.ok) return applied;
    this.activities.recordSafe({
      type: 'wordpress.site.created',
      message: `Deployed WordPress for ${record.domain}`,
      metadata: { siteId: record.id, targetId: record.targetId, domain: record.domain },
    });
    return ok({ site: applied.value, adminPassword: secrets.adminPassword });
  }

  /** Run every step again with the site's own passwords; safe on a working site. */
  async redeploy(
    id: string,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const secrets = await this.secrets(site.value);
    if (!secrets.ok) return secrets;
    return this.apply(site.value, secrets.value, onEvent);
  }

  async status(id: string): Promise<Result<WordPressRuntimeStatus, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const target = await this.targets.resolve(site.value.targetId);
    if (!target.ok) return target;
    const status = await this.manager.status(target.value, site.value.project);
    if (!status.ok) return status;
    if (status.value.wordpressVersion !== site.value.wordpressVersion) {
      await this.store.save({
        ...site.value,
        wordpressVersion: status.value.wordpressVersion,
        updatedAt: new Date().toISOString(),
      });
    }
    return status;
  }

  /** Latest images and WordPress core; content, plugins and the database are kept. */
  async update(
    id: string,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const target = await this.targets.resolve(site.value.targetId);
    if (!target.ok) return target;
    const updated = await this.manager.update(target.value, site.value.project, onEvent);
    if (!updated.ok) return this.fail(site.value, updated.error);
    const record = {
      ...site.value,
      status: 'running' as const,
      wordpressVersion: updated.value.wordpressVersion,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.store.save(record);
    if (!saved.ok) return saved;
    this.activities.recordSafe({
      type: 'wordpress.site.updated',
      message: `Updated WordPress for ${record.domain} to ${record.wordpressVersion ?? 'the latest version'}`,
      metadata: { siteId: record.id, targetId: record.targetId, domain: record.domain },
    });
    return ok(record);
  }

  /**
   * Remove the containers and the Nginx site. Without `deleteData` the volumes,
   * the server directory and the passwords stay, so creating the site again
   * reattaches the same content.
   */
  async remove(
    id: string,
    deleteData: boolean,
    onEvent?: WordPressEventSink,
  ): Promise<Result<void, WordPressServiceError>> {
    const site = await this.load(id);
    if (!site.ok) return site;
    const target = await this.targets.resolve(site.value.targetId);
    if (!target.ok) return target;
    const removed = await this.manager.remove(
      target.value,
      site.value.project,
      deleteData,
      onEvent,
    );
    if (!removed.ok) return removed;
    if (this.nginx) {
      const sites = await this.nginx.listSites(site.value.targetId);
      const nginxSite = sites.ok
        ? sites.value.find((item) => item.domain === site.value.domain && item.managed !== false)
        : undefined;
      if (nginxSite) {
        const unpublished = await this.nginx.removeSite(site.value.targetId, site.value.domain);
        if (!unpublished.ok)
          return err(
            new DeploymentError('The containers were removed but the Nginx site was not', {
              cause: unpublished.error,
            }),
          );
      }
    }
    if (deleteData) await this.credentials.remove(site.value.credentialId);
    const deleted = await this.store.remove(id);
    if (!deleted.ok) return deleted;
    this.activities.recordSafe({
      type: 'wordpress.site.removed',
      message: `Removed WordPress for ${site.value.domain}${deleteData ? ' and its data' : ''}`,
      metadata: {
        siteId: id,
        targetId: site.value.targetId,
        domain: site.value.domain,
        deleteData,
      },
    });
    return ok(undefined);
  }

  private async apply(
    site: WordPressSiteRecord,
    secrets: SiteSecrets,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const step = (message: string): void => onEvent?.({ stream: 'step', message });
    const target = await this.targets.resolve(site.targetId);
    if (!target.ok) return this.fail(site, target.error);
    const siteUrl = wordpressSiteUrl(site.domain, site.https);

    step(`Deploying WordPress containers for ${site.domain}`);
    const deployed = await this.manager.deploy(
      target.value,
      {
        project: site.project,
        composeYaml: renderWordPressCompose({
          project: site.project,
          domain: site.domain,
          hostPort: site.hostPort,
          siteUrl,
        }),
        phpIni: renderWordPressPhpIni(),
        hostPort: site.hostPort,
        siteUrl,
        siteTitle: site.siteTitle,
        adminUser: site.adminUser,
        adminEmail: site.adminEmail,
        secrets,
      },
      onEvent,
    );
    if (!deployed.ok) return this.fail(site, deployed.error);

    const warnings: string[] = [];
    let dnsReady = !site.cloudflareCredentialId;
    if (site.cloudflareCredentialId) {
      if (!this.managedDns) {
        warnings.push('Cloudflare automation is not available, so DNS was not created.');
      } else {
        step(`Pointing ${site.domain} to ${target.value.host} in Cloudflare`);
        const dns = await this.managedDns.ensure(
          site.domain,
          target.value.host,
          site.cloudflareCredentialId,
          site.cloudflareZoneId ?? undefined,
        );
        if (!dns.ok) {
          const detail = dns.error instanceof Error ? dns.error.message : 'unknown error';
          warnings.push(`Cloudflare DNS could not be configured: ${detail}`);
        } else if (dns.value.status !== 'propagated') {
          warnings.push(
            dns.value.warning ??
              'Cloudflare DNS was created but has not propagated yet. Redeploy in a few minutes to enable HTTPS.',
          );
        } else {
          dnsReady = true;
          if (dns.value.warning) warnings.push(dns.value.warning);
        }
      }
    }

    if (!this.nginx) {
      warnings.push('Nginx automation is not available, so the domain was not published.');
    } else {
      step(`Publishing ${site.domain} with Nginx`);
      const published = await this.publish(site);
      if (!published.ok) return this.fail(site, published.error);
    }

    if (site.https && this.nginx) {
      if (!this.certificates) {
        warnings.push('Certificate automation is not available, so HTTPS was not enabled.');
      } else if (!dnsReady && site.cloudflareCredentialId) {
        warnings.push('HTTPS waits for DNS. Redeploy once the domain points to the server.');
      } else {
        step(`Requesting the HTTPS certificate for ${site.domain}`);
        const certificate = await this.certificates.issue(
          site.targetId,
          {
            domain: site.domain,
            email: site.certificateEmail ?? site.adminEmail,
            certificateVolume: WORDPRESS_CERTIFICATE_VOLUME,
            webrootVolume: WORDPRESS_WEBROOT_VOLUME,
            forceRenewal: false,
            authority: 'letsencrypt',
            ...(site.cloudflareCredentialId
              ? { cloudflareCredentialId: site.cloudflareCredentialId }
              : {}),
          },
          (event) => onEvent?.(event),
        );
        if (!certificate.ok) {
          const detail =
            certificate.error instanceof Error ? certificate.error.message : 'unknown error';
          warnings.push(`HTTPS is not enabled yet: ${detail}. Fix the cause, then use Redeploy.`);
        }
      }
    }

    const record: WordPressSiteRecord = {
      ...site,
      status: 'running',
      wordpressVersion: deployed.value.wordpressVersion,
      warnings,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.store.save(record);
    if (!saved.ok) return saved;
    step(
      warnings.length === 0
        ? `WordPress ${record.wordpressVersion ?? ''} is live at ${siteUrl}`.replace('  ', ' ')
        : `WordPress is running with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    );
    return ok(record);
  }

  /** Point the domain at the site's loopback port, keeping any HTTPS already set up. */
  private async publish(site: WordPressSiteRecord): Promise<Result<void, WordPressServiceError>> {
    const nginx = this.nginx;
    if (!nginx) return ok(undefined);
    const sites = await nginx.listSites(site.targetId);
    if (!sites.ok)
      return err(new DeploymentError('Could not read the Nginx sites', { cause: sites.error }));
    const existing = sites.value.find((item) => item.domain.toLowerCase() === site.domain);
    if (existing?.managed === false)
      return err(
        new ConflictError(
          `${site.domain} already has an Nginx site that CloudForge does not manage. Remove it or use another domain.`,
        ),
      );
    // Our own site proxies to this site's port; any other port is another application.
    if (existing && existing.upstreamPort !== site.hostPort)
      return err(
        new ConflictError(
          `Nginx already serves ${site.domain} for another application (port ${String(existing.upstreamPort)}).`,
        ),
      );
    const now = new Date().toISOString();
    const upstream = {
      enabled: true,
      upstreamKind: 'host' as const,
      upstreamHost: '127.0.0.1',
      upstreamPort: site.hostPort,
      websocket: false,
      locations: [],
      proxyTimeoutSeconds: 300,
      clientMaxBodySize: '64m',
      lastModified: now,
    };
    const next: ManagedNginxSite = existing
      ? { ...existing, ...upstream }
      : {
          domain: site.domain,
          ...upstream,
          ssl: false,
          httpRedirect: false,
          headers: [],
          extraDirectives: [],
          compression: true,
          cache: false,
          customSnippets: [],
        };
    const saved = await nginx.saveSite(site.targetId, next);
    if (!saved.ok)
      return err(new DeploymentError('Nginx could not publish the site', { cause: saved.error }));
    return ok(undefined);
  }

  private async secrets(
    site: WordPressSiteRecord,
  ): Promise<Result<SiteSecrets, WordPressServiceError>> {
    const read = await this.readSecret(site.credentialId, site.domain);
    return read.ok ? ok(read.value.secrets) : read;
  }

  /** The secret a previous Remove kept for this domain, if any. */
  private async keptSecrets(
    domain: string,
  ): Promise<
    Result<
      { credentialId: string; secrets: SiteSecrets; adminUser: string | null } | null,
      WordPressServiceError
    >
  > {
    const listed = await this.credentials.list();
    if (!listed.ok) return listed;
    const existing = listed.value.find(
      (credential) =>
        credential.kind === 'environment-file' && credential.name === secretName(domain),
    );
    if (!existing) return ok(null);
    const read = await this.readSecret(existing.id, domain);
    return read.ok ? ok({ credentialId: existing.id, ...read.value }) : read;
  }

  private async readSecret(
    credentialId: string,
    domain: string,
  ): Promise<Result<{ secrets: SiteSecrets; adminUser: string | null }, WordPressServiceError>> {
    const credential = await this.credentials.getDecrypted(credentialId);
    if (!credential.ok)
      return err(
        new NotFoundError(`The passwords for ${domain} are missing from Secrets`, {
          cause: credential.error,
        }),
      );
    const values = parseEnvironment(credential.value.data.content ?? '');
    const databasePassword = values.get('DB_PASSWORD');
    const databaseRootPassword = values.get('DB_ROOT_PASSWORD');
    const adminPassword = values.get('WORDPRESS_ADMIN_PASSWORD');
    if (!databasePassword || !databaseRootPassword || !adminPassword)
      return err(
        new ValidationError(
          `The secret "${secretName(domain)}" lost DB_PASSWORD, DB_ROOT_PASSWORD or WORDPRESS_ADMIN_PASSWORD`,
        ),
      );
    const adminUser = values.get('WORDPRESS_ADMIN_USER')?.trim() ?? '';
    return ok({
      secrets: { databasePassword, databaseRootPassword, adminPassword },
      adminUser: adminUser === '' ? null : adminUser,
    });
  }

  private async load(id: string): Promise<Result<WordPressSiteRecord, WordPressServiceError>> {
    const sites = await this.store.list();
    if (!sites.ok) return sites;
    const site = sites.value.find((item) => item.id === id);
    return site ? ok(site) : err(new NotFoundError('This WordPress site no longer exists'));
  }

  private async fail(
    site: WordPressSiteRecord,
    cause: WordPressServiceError | DeploymentError,
  ): Promise<Result<never, WordPressServiceError>> {
    await this.store.save({
      ...site,
      status: 'failed',
      lastError: cause.message,
      updatedAt: new Date().toISOString(),
    });
    this.activities.recordSafe({
      type: 'wordpress.site.failed',
      message: `WordPress for ${site.domain} failed: ${cause.message}`,
      metadata: { siteId: site.id, targetId: site.targetId, domain: site.domain },
    });
    return err(cause);
  }
}

function secretName(domain: string): string {
  return `WordPress · ${domain}`;
}

/** KEY=VALUE lines; the value is everything after the first `=`. */
function parseEnvironment(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1));
  }
  return values;
}
