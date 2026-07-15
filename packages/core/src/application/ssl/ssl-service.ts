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

export class SslService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly dns: DomainResolver,
    private readonly certificates: CertificateManager,
    private readonly activities: ActivityService,
    private readonly settings?: SettingsService,
    private readonly nginx?: NginxService,
    private readonly managedDns?: ManagedDnsCoordinator,
  ) {}

  async verifyDns(
    targetId: string,
    domain: string,
  ): Promise<
    Result<
      {
        domainIps: readonly string[];
        targetIps: readonly string[];
        matches: boolean;
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
    const domainIps = await this.dns.resolve(normalized.value.replace(/^\*\./, ''));
    if (!domainIps.ok) return domainIps;
    const targetIps = isIp(target.value.host)
      ? ok([target.value.host])
      : await this.dns.resolve(target.value.host);
    if (!targetIps.ok) return targetIps;
    const expectedIp = targetIps.value[0];
    if (expectedIp && this.managedDns?.verify) {
      const cloudflare = await this.managedDns.verify(normalized.value, expectedIp);
      if (cloudflare.ok && cloudflare.value.status !== 'error') {
        const matches =
          cloudflare.value.current === expectedIp && cloudflare.value.status === 'propagated';
        return ok({
          domainIps: cloudflare.value.publicAnswers,
          targetIps: targetIps.value,
          matches,
          provider: 'cloudflare',
          proxied: cloudflare.value.proxied,
          sslMode: cloudflare.value.sslMode,
          certificateRequirement: cloudflare.value.certificateRequirement,
          message: cloudflareSslMessage(
            cloudflare.value.proxied,
            cloudflare.value.sslMode,
            cloudflare.value.certificateRequirement,
          ),
        });
      }
    }
    const matches = domainIps.value.some((ip) => targetIps.value.includes(ip));
    return ok({
      domainIps: domainIps.value,
      targetIps: targetIps.value,
      matches,
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
  ): Promise<Result<CertificateDetails, ValidationError | DeploymentError>> {
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
      const prepared = await this.managedDns.ensure(valid.value.domain, expectedIp);
      if (!prepared.ok)
        return err(
          new DeploymentError('Automatic Cloudflare DNS preparation failed', {
            cause: prepared.error,
          }),
        );
      if (prepared.value.status !== 'propagated')
        return err(new ValidationError('Cloudflare DNS exists but propagation is still pending'));
    } else {
      const dns = await this.verifyDns(targetId, valid.value.domain);
      if (!dns.ok) return dns;
      if (!dns.value.matches)
        return err(
          new ValidationError(
            `DNS does not point to this VPS (domain: ${dns.value.domainIps.join(', ') || 'none'}; VPS: ${dns.value.targetIps.join(', ') || 'none'})`,
          ),
        );
    }
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
      const challenge = await this.nginx.saveSite(targetId, {
        ...nginxSite,
        acmeWebroot: valid.value.webrootVolume,
        lastModified: new Date().toISOString(),
      });
      if (!challenge.ok) return challenge;
    }
    const issued = await this.certificates.issue(target.value, valid.value, onEvent);
    this.activities.recordSafe({
      type: issued.ok ? 'ssl.issued' : 'ssl.failed',
      message: issued.ok
        ? `Issued certificate for ${valid.value.domain}`
        : `Certificate issue failed for ${valid.value.domain}`,
      metadata: { targetId, domain: valid.value.domain },
    });
    if (issued.ok && this.settings) {
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
      if (nginxSite)
        await this.nginx.saveSite(
          targetId,
          {
            ...nginxSite,
            acmeWebroot: valid.value.webrootVolume,
            ssl: true,
            httpRedirect: currentSettings?.ok
              ? currentSettings.value.cloudflare.automaticHttpsRedirect
              : true,
            certificatePath: `${valid.value.certificateVolume}/live/${valid.value.domain}`,
            lastModified: new Date().toISOString(),
          },
          onEvent,
        );
    }
    return issued;
  }

  async list(
    targetId: string,
    volume: string,
  ): Promise<Result<CertificateDetails[], ValidationError | DeploymentError>> {
    if (!validAbsolutePath(volume))
      return err(new ValidationError('Certificate volume must be an absolute path'));
    const target = await this.targets.resolve(targetId);
    return target.ok ? this.certificates.list(target.value, volume) : target;
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
      if (renewed.ok && this.nginx) await this.nginx.reload(item.targetId);
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
  if (domain.value.startsWith('*.'))
    return err(
      new ValidationError(
        'Wildcard certificates require a DNS-01 provider integration; the configured webroot flow supports exact domains only.',
      ),
    );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email))
    return err(new ValidationError('Enter a valid certificate email'));
  if (!validAbsolutePath(config.certificateVolume) || !validAbsolutePath(config.webrootVolume))
    return err(new ValidationError('Certbot volumes must be absolute paths'));
  return ok({ ...config, domain: domain.value, email: config.email.trim() });
}
function validAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !/[\r\n\0]/.test(value);
}
function isIp(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':');
}
