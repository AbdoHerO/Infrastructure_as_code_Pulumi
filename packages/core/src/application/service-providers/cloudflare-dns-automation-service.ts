import {
  err,
  ok,
  ServiceProviderError,
  ValidationError,
  type Result,
  type ConflictError,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DomainResolver } from '../ports/certificate-manager.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { AppSettings } from '../settings/settings.js';
import type { CloudflareDnsRecord } from './cloudflare.js';
import type { CloudflareService } from './cloudflare-service.js';

export interface CloudflareDnsPropagation {
  readonly domain: string;
  readonly expected: string;
  readonly current: string;
  readonly status: 'pending' | 'propagated' | 'error';
  readonly ttl: number;
  readonly proxied: boolean;
  readonly publicAnswers: readonly string[];
  readonly warning: string | null;
  readonly sslMode: string;
  readonly certificateRequirement: 'required' | 'recommended';
}

export class CloudflareDnsAutomationService {
  constructor(
    private readonly cloudflare: CloudflareService,
    private readonly settings: SettingsService,
    private readonly dns: DomainResolver,
    private readonly activities: ActivityService,
  ) {}

  async ensure(
    domain: string,
    expectedIp: string,
    credentialId?: string,
    zoneId?: string,
  ): Promise<Result<CloudflareDnsPropagation, CloudflareDnsAutomationFailure>> {
    const context = await this.context(domain, expectedIp, credentialId, zoneId);
    if (!context.ok) return context;
    const { credential, zone, config, normalized } = context.value;
    const records = await this.cloudflare.dnsRecords(credential, zone);
    if (!records.ok) return records;
    const type = expectedIp.includes(':') ? 'AAAA' : 'A';
    const existing = records.value.find(
      (record) => record.name.replace(/\.$/, '') === normalized && record.type === type,
    );
    const input = {
      type,
      name: normalized,
      content: expectedIp,
      ttl: config.defaultTtl,
      proxied: config.defaultProxy,
      comment: 'Managed by CloudForge',
      tags: ['cloudforge'],
    } as const;
    const saved = existing
      ? await this.cloudflare.updateDnsRecord(credential, zone, existing.id, input)
      : await this.cloudflare.createDnsRecord(credential, zone, input);
    if (!saved.ok) return saved;
    const zoneSettings = await this.cloudflare.zoneSettings(credential, zone);
    const sslMode = zoneSettings.ok ? zoneSettings.value.sslMode : 'unknown';
    if (config.activityLogging)
      this.activities.recordSafe({
        type: 'cloudflare.dns.automatic',
        message: `Prepared DNS for ${normalized}`,
        metadata: { zoneId: zone, domain: normalized, proxied: saved.value.proxied },
      });
    return config.waitForPropagation
      ? this.wait(saved.value, expectedIp, config.propagationTimeoutSeconds, sslMode)
      : ok(this.status(saved.value, expectedIp, [], 'pending', sslMode));
  }

  async verify(
    domain: string,
    expectedIp: string,
    credentialId?: string,
    zoneId?: string,
  ): Promise<Result<CloudflareDnsPropagation, CloudflareDnsAutomationFailure>> {
    const context = await this.context(domain, expectedIp, credentialId, zoneId);
    if (!context.ok) return context;
    const records = await this.cloudflare.dnsRecords(context.value.credential, context.value.zone);
    if (!records.ok) return records;
    const zoneSettings = await this.cloudflare.zoneSettings(
      context.value.credential,
      context.value.zone,
    );
    const sslMode = zoneSettings.ok ? zoneSettings.value.sslMode : 'unknown';
    const record = records.value.find(
      (item) =>
        item.name.replace(/\.$/, '') === context.value.normalized &&
        (item.type === 'A' || item.type === 'AAAA'),
    );
    if (!record)
      return ok({
        domain: context.value.normalized,
        expected: expectedIp,
        current: '',
        status: 'error',
        ttl: 0,
        proxied: false,
        publicAnswers: [],
        warning: 'No Cloudflare A or AAAA record exists for this domain.',
        sslMode,
        certificateRequirement: 'required',
      });
    const answers = await this.dns.resolve(context.value.normalized);
    const publicAnswers = answers.ok ? answers.value : [];
    const propagated =
      record.content === expectedIp &&
      (record.proxied ? publicAnswers.length > 0 : publicAnswers.includes(expectedIp));
    return ok(
      this.status(
        record,
        expectedIp,
        publicAnswers,
        propagated ? 'propagated' : 'pending',
        sslMode,
      ),
    );
  }

  private async context(
    domain: string,
    expectedIp: string,
    credentialId?: string,
    zoneId?: string,
  ): Promise<
    Result<
      {
        credential: string;
        zone: string;
        normalized: string;
        config: AppSettings['cloudflare'];
      },
      CloudflareDnsAutomationFailure
    >
  > {
    const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(normalized))
      return err(new ValidationError('Enter a valid domain'));
    if (!validIp(expectedIp))
      return err(new ValidationError('Enter a valid public IPv4 or IPv6 address'));
    const settings = await this.settings.get();
    if (!settings.ok)
      return err(
        new ServiceProviderError('Could not load Cloudflare settings', { cause: settings.error }),
      );
    const requestedCredential = nonEmpty(credentialId);
    const credential = requestedCredential ?? settings.value.cloudflare.defaultCredentialId;
    if (!credential) return err(new ValidationError('Select a Cloudflare credential'));
    const zones = await this.cloudflare.zones(credential);
    if (!zones.ok) return zones;
    const requestedZone = nonEmpty(zoneId);
    const configuredZone = nonEmpty(settings.value.cloudflare.defaultZoneId);
    const matchingZone = zones.value
      .filter((item) => normalized === item.name || normalized.endsWith(`.${item.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0]?.id;
    const zone = requestedZone ?? configuredZone ?? matchingZone;
    if (!zone) return err(new ValidationError('No Cloudflare zone matches this domain'));
    return ok({ credential, zone, normalized, config: settings.value.cloudflare });
  }

  private async wait(
    record: CloudflareDnsRecord,
    expectedIp: string,
    timeoutSeconds: number,
    sslMode: string,
  ): Promise<Result<CloudflareDnsPropagation, ServiceProviderError>> {
    const attempts = Math.max(1, Math.ceil(timeoutSeconds / 5));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const answers = await this.dns.resolve(record.name);
      const values = answers.ok ? answers.value : [];
      if (record.proxied ? values.length > 0 : values.includes(expectedIp))
        return ok(this.status(record, expectedIp, values, 'propagated', sslMode));
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    return ok(this.status(record, expectedIp, [], 'pending', sslMode));
  }

  private status(
    record: CloudflareDnsRecord,
    expectedIp: string,
    answers: readonly string[],
    status: CloudflareDnsPropagation['status'],
    sslMode: string,
  ): CloudflareDnsPropagation {
    return {
      domain: record.name,
      expected: expectedIp,
      current: record.content,
      status,
      ttl: record.ttl,
      proxied: record.proxied,
      publicAnswers: answers,
      warning:
        record.content !== expectedIp
          ? 'The Cloudflare origin record does not match the expected VPS public IP.'
          : record.proxied
            ? 'Cloudflare proxy is enabled; public DNS correctly returns Cloudflare edge addresses.'
            : null,
      sslMode,
      certificateRequirement:
        !record.proxied || sslMode === 'off' || sslMode === 'full' || sslMode === 'strict'
          ? 'required'
          : 'recommended',
    };
  }
}

type CloudflareDnsAutomationFailure = ServiceProviderError | ValidationError | ConflictError;

function validIp(value: string): boolean {
  if (value.includes(':')) return /^[0-9a-f:]+$/i.test(value);
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
