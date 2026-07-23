import { DeploymentError, err, ok, type Result, ValidationError } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  CertificateDetails,
  CertificateEventSink,
  CertificateIssueConfig,
  CertificateManager,
  DomainResolver,
  ManagedDnsCoordinator,
} from '../ports/certificate-manager.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { NginxService } from '../nginx/nginx-service.js';
import type { ManagedNginxSite } from '../ports/nginx-manager.js';
import type { CloudflareService } from '../service-providers/cloudflare-service.js';
import type {
  RuntimeCertificateSync,
  RuntimeTopologySynchronizer,
  RuntimeTopologySyncError,
} from '../ports/runtime-topology-synchronizer.js';

type SslServiceError = ValidationError | DeploymentError | RuntimeTopologySyncError;

export class SslService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly dns: DomainResolver,
    private readonly certificates: CertificateManager,
    private readonly activities: ActivityService,
    private readonly settings?: SettingsService,
    private readonly nginx?: NginxService,
    private readonly managedDns?: ManagedDnsCoordinator,
    private readonly cloudflare?: CloudflareService,
    private readonly runtime?: RuntimeTopologySynchronizer,
  ) {}

  async verifyDns(
    targetId: string,
    domain: string,
    cloudflareCredentialId?: string,
  ): Promise<
    Result<
      {
        domainIps: readonly string[];
        targetIps: readonly string[];
        matches: boolean;
        status: 'pending' | 'propagated' | 'error';
        provider: 'cloudflare' | 'public-dns';
        proxied: boolean;
        sslMode: string;
        certificateRequirement: 'required' | 'recommended';
        message: string;
      },
      ValidationError | DeploymentError
    >
  > {
    const normalized = validateDomain(domain);
    if (!normalized.ok) return normalized;
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    const targetIps = isIp(target.value.host)
      ? ok([target.value.host])
      : await this.dns.resolve(target.value.host);
    if (!targetIps.ok) return targetIps;
    const expectedIp = targetIps.value[0];
    if (expectedIp && this.managedDns?.verify) {
      const cloudflare = await this.managedDns.verify(
        normalized.value,
        expectedIp,
        cloudflareCredentialId,
      );
      if (cloudflare.ok) {
        const matches =
          cloudflare.value.current === expectedIp && cloudflare.value.status === 'propagated';
        return ok({
          domainIps: cloudflare.value.publicAnswers,
          targetIps: targetIps.value,
          matches,
          status: cloudflare.value.status,
          provider: 'cloudflare',
          proxied: cloudflare.value.proxied,
          sslMode: cloudflare.value.sslMode,
          certificateRequirement: cloudflare.value.certificateRequirement,
          message:
            cloudflare.value.warning ??
            cloudflareSslMessage(
              cloudflare.value.proxied,
              cloudflare.value.sslMode,
              cloudflare.value.certificateRequirement,
            ),
        });
      }
    }
    const domainIps = await this.dns.resolve(normalized.value.replace(/^\*\./, ''));
    if (!domainIps.ok) return domainIps;
    const matches = domainIps.value.some((ip) => targetIps.value.includes(ip));
    return ok({
      domainIps: domainIps.value,
      targetIps: targetIps.value,
      matches,
      status: matches ? 'propagated' : 'error',
      provider: 'public-dns',
      proxied: false,
      sslMode: 'not-applicable',
      certificateRequirement: 'required',
      message: 'DNS-only traffic connects directly to the VPS, so the origin needs a certificate.',
    });
  }

  async issue(
    targetId: string,
    config: CertificateIssueConfig,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, SslServiceError>> {
    const valid = validateConfig(config);
    if (!valid.ok) return valid;
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    const currentSettings = this.settings ? await this.settings.get() : null;
    const automaticDns = currentSettings?.ok
      ? currentSettings.value.cloudflare.automaticDnsCreation
      : false;
    if (automaticDns && this.managedDns) {
      const targetIps = isIp(target.value.host)
        ? ok([target.value.host])
        : await this.dns.resolve(target.value.host);
      if (!targetIps.ok) return targetIps;
      const expectedIp = targetIps.value[0];
      if (!expectedIp) return err(new ValidationError('The VPS has no resolvable public IP'));
      const prepared = await this.managedDns.ensure(
        valid.value.domain,
        expectedIp,
        valid.value.cloudflareCredentialId,
      );
      if (!prepared.ok)
        return err(
          new DeploymentError('Automatic Cloudflare DNS preparation failed', {
            cause: prepared.error,
          }),
        );
      if (prepared.value.status !== 'propagated')
        return err(new ValidationError('Cloudflare DNS exists but propagation is still pending'));
    } else {
      const dns = await this.verifyDns(
        targetId,
        valid.value.domain,
        valid.value.cloudflareCredentialId,
      );
      if (!dns.ok) return dns;
      if (!dns.value.matches)
        return err(
          new ValidationError(
            `DNS does not point to this VPS (domain: ${dns.value.domainIps.join(', ') || 'none'}; VPS: ${dns.value.targetIps.join(', ') || 'none'})`,
          ),
        );
    }
    const authority = valid.value.authority ?? 'letsencrypt';
    let nginxSite: ManagedNginxSite | undefined;
    if (this.nginx) {
      const sites = await this.nginx.listSites(targetId);
      nginxSite = sites.ok
        ? sites.value.find((item) => item.domain === valid.value.domain && item.managed !== false)
        : undefined;
      if (!nginxSite)
        return err(
          new ValidationError(
            'Create a CloudForge-managed Nginx site for this exact domain before issuing SSL.',
          ),
        );
      if (authority === 'letsencrypt') {
        const challenge = await this.nginx.saveSite(targetId, {
          ...nginxSite,
          acmeWebroot: valid.value.webrootVolume,
          lastModified: new Date().toISOString(),
        });
        if (!challenge.ok) return challenge;
      }
    }
    let issued: Result<CertificateDetails, DeploymentError>;
    if (authority === 'cloudflare-origin-ca') {
      if (!this.cloudflare)
        return err(new DeploymentError('Cloudflare Origin CA is not configured in this build'));
      const hostnames = valid.value.includeWildcard
        ? [valid.value.domain, `*.${valid.value.domain}`]
        : [valid.value.domain];
      const prepared = await this.certificates.prepareOriginCertificate(
        target.value,
        valid.value,
        hostnames,
        onEvent,
      );
      if (!prepared.ok) return prepared;
      const origin = await this.cloudflare.createOriginCertificate(
        valid.value.cloudflareCredentialId ?? '',
        {
          csr: prepared.value.csr,
          hostnames,
          requestType: valid.value.keyAlgorithm === 'ecc' ? 'origin-ecc' : 'origin-rsa',
          validityDays: valid.value.validityDays ?? 5475,
        },
      );
      if (!origin.ok) {
        await this.certificates.discardOriginCertificate(target.value, prepared.value.workspace);
        return err(
          new DeploymentError('Cloudflare Origin CA certificate creation failed', {
            cause: origin.error,
          }),
        );
      }
      issued = await this.certificates.installOriginCertificate(
        target.value,
        valid.value,
        prepared.value.workspace,
        origin.value.certificate,
        onEvent,
      );
      if (!issued.ok)
        await this.certificates.discardOriginCertificate(target.value, prepared.value.workspace);
    } else {
      issued = await this.certificates.issue(target.value, valid.value, onEvent);
    }
    this.activities.recordSafe({
      type: issued.ok ? 'ssl.issued' : 'ssl.failed',
      message: issued.ok
        ? `Issued certificate for ${valid.value.domain}`
        : `Certificate issue failed for ${valid.value.domain}`,
      metadata: { targetId, domain: valid.value.domain, authority },
    });
    if (issued.ok && this.settings && authority === 'letsencrypt') {
      const current = await this.settings.get();
      if (current.ok) {
        const managed = current.value.ssl.managed.filter(
          (item) => !(item.targetId === targetId && item.domain === valid.value.domain),
        );
        await this.settings.update({
          ssl: {
            managed: [
              ...managed,
              {
                targetId,
                domain: valid.value.domain,
                email: valid.value.email,
                certificateVolume: valid.value.certificateVolume,
                webrootVolume: valid.value.webrootVolume,
              },
            ],
          },
        });
      }
    }
    if (issued.ok && this.nginx) {
      if (nginxSite) {
        const applied = await this.nginx.saveSite(
          targetId,
          {
            ...nginxSite,
            ...(authority === 'letsencrypt' ? { acmeWebroot: valid.value.webrootVolume } : {}),
            ssl: true,
            httpRedirect: currentSettings?.ok
              ? currentSettings.value.cloudflare.automaticHttpsRedirect
              : true,
            certificatePath: `${valid.value.certificateVolume}/live/${valid.value.domain}`,
            lastModified: new Date().toISOString(),
          },
          onEvent,
        );
        if (!applied.ok) return applied;
      }
    }
    if (issued.ok && authority === 'cloudflare-origin-ca' && this.cloudflare) {
      const strict = await this.cloudflare.enableStrictSslForDomain(
        valid.value.cloudflareCredentialId ?? '',
        valid.value.domain,
      );
      if (!strict.ok)
        return err(
          new DeploymentError(
            'The Origin certificate and Nginx configuration are active, but Cloudflare Full (strict) could not be enabled',
            { cause: strict.error },
          ),
        );
    }
    if (issued.ok && this.runtime) {
      const runtime = await this.runtime.upsertCertificate(
        toRuntimeCertificate(
          targetId,
          valid.value.certificateVolume,
          issued.value,
          authority,
          true,
          currentSettings?.ok ? currentSettings.value.cloudflare.automaticHttpsRedirect : true,
        ),
      );
      if (!runtime.ok) return runtime;
    }
    return issued;
  }

  async list(
    targetId: string,
    volume: string,
  ): Promise<Result<CertificateDetails[], SslServiceError>> {
    if (!validAbsolutePath(volume))
      return err(new ValidationError('Certificate volume must be an absolute path'));
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    const certificates = await this.certificates.list(target.value, volume);
    if (!certificates.ok || !this.runtime) return certificates;
    const sites = this.nginx ? await this.nginx.listSites(targetId) : null;
    // A transient Nginx read failure is not evidence that HTTPS and redirect
    // were disabled. Keep the last authoritative topology rather than
    // publishing false values that create spurious certificate drift.
    if (sites && !sites.ok) {
      this.activities.recordSafe({
        type: 'ssl.runtime.sync.skipped',
        message: 'Loaded certificates but kept the previous Runtime HTTPS state',
        metadata: { targetId, reason: sites.error.message },
      });
      return certificates;
    }
    const synchronized = await this.runtime.replaceCertificates(
      targetId,
      volume,
      certificates.value.map((certificate) => {
        const site = sites?.ok
          ? sites.value.find((item) => item.domain === certificate.domain)
          : undefined;
        return toRuntimeCertificate(
          targetId,
          volume,
          certificate,
          authorityFromIssuer(certificate.issuer),
          site?.ssl ?? false,
          site?.httpRedirect ?? false,
        );
      }),
    );
    return synchronized.ok ? certificates : synchronized;
  }

  async export(
    targetId: string,
    certificateVolume: string,
    domain: string,
    format: 'pem' | 'crt' | 'key' | 'zip',
  ): Promise<Result<{ name: string; contentBase64: string }, ValidationError | DeploymentError>> {
    const valid = validateDomain(domain);
    if (!valid.ok) return valid;
    if (!validAbsolutePath(certificateVolume))
      return err(new ValidationError('Certificate volume must be an absolute path'));
    const target = await this.targets.resolve(targetId);
    return target.ok
      ? this.certificates.export(target.value, certificateVolume, valid.value, format)
      : target;
  }

  async renewDue(): Promise<void> {
    if (!this.settings) return;
    const settings = await this.settings.get();
    if (!settings.ok || !settings.value.ssl.autoRenew) return;
    for (const item of settings.value.ssl.managed) {
      const target = await this.targets.resolve(item.targetId);
      if (!target.ok) {
        this.activities.recordSafe({
          type: 'ssl.renewal.failed',
          message: `Could not resolve target for ${item.domain}`,
        });
        continue;
      }
      const listed = await this.certificates.list(target.value, item.certificateVolume);
      const current = listed.ok
        ? listed.value.find((certificate) => certificate.domain === item.domain)
        : undefined;
      if (current && current.daysRemaining > settings.value.ssl.renewBeforeDays) continue;
      const renewed = await this.certificates.renew(target.value, { ...item, forceRenewal: false });
      let reloadSucceeded = true;
      if (renewed.ok && this.nginx) {
        const reloaded = await this.nginx.reload(item.targetId);
        if (!reloaded.ok) {
          reloadSucceeded = false;
          this.activities.recordSafe({
            type: 'ssl.reload.failed',
            message: `Renewed ${item.domain}, but Nginx could not reload the certificate`,
            metadata: {
              targetId: item.targetId,
              domain: item.domain,
              error: reloaded.error.message,
            },
          });
        }
      }
      if (renewed.ok && this.runtime && reloadSucceeded) {
        const sites = this.nginx ? await this.nginx.listSites(item.targetId) : null;
        const site = sites?.ok
          ? sites.value.find((candidate) => candidate.domain === item.domain)
          : undefined;
        const synchronized = await this.runtime.upsertCertificate(
          toRuntimeCertificate(
            item.targetId,
            item.certificateVolume,
            renewed.value,
            authorityFromIssuer(renewed.value.issuer),
            site?.ssl ?? true,
            site?.httpRedirect ?? false,
          ),
        );
        if (!synchronized.ok) {
          this.activities.recordSafe({
            type: 'ssl.runtime.sync.failed',
            message: `Renewed ${item.domain}, but could not synchronize its Runtime certificate`,
            metadata: {
              targetId: item.targetId,
              domain: item.domain,
              error: synchronized.error.message,
            },
          });
        }
      }
      if (renewed.ok && this.runtime && !reloadSucceeded) {
        this.activities.recordSafe({
          type: 'ssl.runtime.sync.skipped',
          message: `Kept the last accepted Runtime certificate for ${item.domain} because Nginx did not reload`,
          metadata: { targetId: item.targetId, domain: item.domain },
        });
      }
      this.activities.recordSafe({
        type: renewed.ok ? 'ssl.renewed' : 'ssl.renewal.failed',
        message: renewed.ok
          ? `Renewed certificate for ${item.domain}`
          : `Renewal failed for ${item.domain}`,
        metadata: { targetId: item.targetId, domain: item.domain },
      });
    }
  }
}

function authorityFromIssuer(issuer: string): RuntimeCertificateSync['authority'] {
  if (/let'?s encrypt/i.test(issuer)) return 'letsencrypt';
  if (/cloudflare/i.test(issuer)) return 'cloudflare-origin-ca';
  return 'unknown';
}

function toRuntimeCertificate(
  targetId: string,
  collectionId: string,
  certificate: CertificateDetails,
  authority: RuntimeCertificateSync['authority'],
  httpsEnabled: boolean,
  httpRedirect: boolean,
): RuntimeCertificateSync {
  return {
    targetId,
    sourceId: `${collectionId}:${certificate.domain}`,
    collectionId,
    domain: certificate.domain,
    authority,
    status:
      certificate.daysRemaining <= 0
        ? 'expired'
        : certificate.daysRemaining <= 30
          ? 'expiring'
          : 'valid',
    expiresAt: certificate.expiresAt,
    daysRemaining: certificate.daysRemaining,
    httpsEnabled,
    httpRedirect,
    fingerprint: certificate.fingerprint,
    ownership: 'cloudforge-managed',
    observedAt: new Date().toISOString(),
  };
}

function cloudflareSslMessage(
  proxied: boolean,
  sslMode: string,
  requirement: 'required' | 'recommended',
): string {
  if (!proxied)
    return 'The record is DNS-only. Visitors connect directly to the VPS, so an origin certificate is required.';
  if (sslMode === 'strict')
    return 'Cloudflare edge SSL is active. Full (strict) also requires a valid certificate on this VPS.';
  if (sslMode === 'full')
    return 'Cloudflare edge SSL is active. Full mode requires HTTPS on this VPS; a trusted certificate is recommended.';
  if (sslMode === 'flexible')
    return 'Cloudflare edge SSL is active, but Flexible mode leaves the Cloudflare-to-VPS connection unencrypted. Install an origin certificate and use Full (strict).';
  return requirement === 'required'
    ? 'HTTPS requires a certificate on this VPS and an enabled Cloudflare SSL mode.'
    : 'Cloudflare edge SSL is active; an origin certificate is recommended.';
}

const DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
function validateDomain(value: string): Result<string, ValidationError> {
  const domain = value.trim().toLowerCase();
  return DOMAIN.test(domain)
    ? ok(domain)
    : err(new ValidationError('Enter a valid domain or wildcard domain'));
}
function validateConfig(
  config: CertificateIssueConfig,
): Result<CertificateIssueConfig, ValidationError> {
  const domain = validateDomain(config.domain);
  if (!domain.ok) return domain;
  const authority = config.authority ?? 'letsencrypt';
  if (domain.value.startsWith('*.'))
    return err(
      new ValidationError(
        'Select the base domain and enable wildcard coverage instead of entering a wildcard as the primary domain.',
      ),
    );
  if (authority === 'letsencrypt' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email))
    return err(new ValidationError('Enter a valid certificate email'));
  if (
    !validAbsolutePath(config.certificateVolume) ||
    (authority === 'letsencrypt' && !validAbsolutePath(config.webrootVolume))
  )
    return err(new ValidationError('Certbot volumes must be absolute paths'));
  if (authority === 'cloudflare-origin-ca' && !config.cloudflareCredentialId?.trim())
    return err(new ValidationError('Select a Cloudflare credential for Origin CA'));
  if (authority === 'letsencrypt' && config.includeWildcard)
    return err(new ValidationError('Wildcard coverage requires Cloudflare Origin CA'));
  return ok({
    ...config,
    authority,
    domain: domain.value,
    email: config.email.trim(),
    ...(config.cloudflareCredentialId?.trim()
      ? { cloudflareCredentialId: config.cloudflareCredentialId.trim() }
      : {}),
  });
}
function validAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !/[\r\n\0]/.test(value);
}
function isIp(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}
