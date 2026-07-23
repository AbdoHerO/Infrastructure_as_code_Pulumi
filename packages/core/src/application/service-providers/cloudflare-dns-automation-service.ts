import {
  err,
  ok,
  ServiceProviderError,
  ValidationError,
  type Result,
  ConflictError,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DomainResolver } from '../ports/certificate-manager.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { AppSettings } from '../settings/settings.js';
import type { CloudflareDnsRecord } from './cloudflare.js';
import type { CloudflareFailure, CloudflareService } from './cloudflare-service.js';

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

/**
 * The marker CloudForge writes into a record's comment when it creates one.
 *
 * The comment field rather than tags, because DNS record tags are not available
 * on every Cloudflare plan — and a marker that only some accounts can carry is
 * not a marker at all.
 */
export const CLOUDFLARE_MANAGED_COMMENT = 'Managed by CloudForge';

/** Whether CloudForge created this record, on the only evidence Cloudflare keeps. */
function isManagedRecord(record: CloudflareDnsRecord): boolean {
  return record.comment.includes(CLOUDFLARE_MANAGED_COMMENT);
}

/**
 * Whether a record already answers with what CloudForge would set anyway.
 *
 * Only an exact match on both address and type counts. A CNAME that resolves to
 * the right host today is not the same fact: it can be repointed by whoever owns
 * the target, so treating it as equivalent would let CloudForge report a domain
 * as settled on evidence that can change without warning.
 */
function alreadyPointsHere(
  record: CloudflareDnsRecord,
  expectedIp: string,
  type: 'A' | 'AAAA',
): boolean {
  return record.type === type && record.content === expectedIp;
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
    const { credential, zone, zoneStatus, config, normalized } = context.value;
    const records = await this.cloudflare.dnsRecords(credential, zone);
    if (!records.ok) return records;
    const type = expectedIp.includes(':') ? 'AAAA' : 'A';
    const sameType = records.value.find(
      (record) => record.name.replace(/\.$/, '') === normalized && record.type === type,
    );
    // Cloudflare does not permit a CNAME to coexist with an A/AAAA record at
    // the same hostname. Update that record in place so repeated pipeline
    // saves remain idempotent instead of attempting a conflicting create.
    const conflictingCname = records.value.find(
      (record) => record.name.replace(/\.$/, '') === normalized && record.type === 'CNAME',
    );
    const existing = sameType ?? conflictingCname;

    // A record CloudForge did not create is not CloudForge's to repoint. This
    // used to overwrite whatever was at the hostname and stamp its own comment
    // on it, so configuring a pipeline for a domain that already served real
    // traffic silently moved that traffic to the VPS — and claimed the record on
    // the way past. DNS has no undo and no preview; by the time anyone noticed,
    // resolvers worldwide had cached the new answer.
    if (existing && !isManagedRecord(existing) && !alreadyPointsHere(existing, expectedIp, type)) {
      return err(
        new ConflictError(
          `${normalized} already has a ${existing.type} record pointing at ${existing.content}, and CloudForge did not create it. ` +
            `Repointing it at ${expectedIp} would move live traffic. Either point that record at ${expectedIp} in Cloudflare yourself, or delete it, then save again.`,
        ),
      );
    }

    // Already answering with the address CloudForge would set. Nothing to change
    // — and nothing to claim: stamping the marker on a record someone else made
    // would let a later CloudForge action withdraw a record it never created.
    if (existing && !isManagedRecord(existing)) {
      const zoneSettings = await this.cloudflare.zoneSettings(credential, zone);
      const settled = zoneSettings.ok ? zoneSettings.value.sslMode : 'unknown';
      if (config.activityLogging)
        this.activities.recordSafe({
          type: 'cloudflare.dns.unmanaged',
          message: `Left the existing DNS record for ${normalized} untouched; it already points at ${expectedIp}`,
          metadata: { zoneId: zone, domain: normalized, recordId: existing.id },
        });
      return config.waitForPropagation
        ? this.wait(existing, expectedIp, config.propagationTimeoutSeconds, settled, zoneStatus)
        : ok(this.status(existing, expectedIp, [], 'pending', settled));
    }

    const input = {
      type,
      name: normalized,
      content: expectedIp,
      ttl: config.defaultTtl,
      proxied: config.defaultProxy,
      comment: 'Managed by CloudForge',
      // DNS record tags are not available on every Cloudflare plan. Keep the
      // management marker in the broadly supported comment field instead.
      tags: [],
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
        metadata: {
          zoneId: zone,
          domain: normalized,
          proxied: saved.value.proxied,
          previousType: existing?.type ?? null,
        },
      });
    return config.waitForPropagation
      ? this.wait(saved.value, expectedIp, config.propagationTimeoutSeconds, sslMode, zoneStatus)
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
      (record.proxied
        ? context.value.zoneStatus === 'active' || publicAnswers.length > 0
        : publicAnswers.includes(expectedIp));
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
        zoneStatus: string;
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
    const zone = requestedZone ?? matchingZone ?? configuredZone;
    if (!zone) return err(new ValidationError('No Cloudflare zone matches this domain'));
    const selectedZone = zones.value.find((item) => item.id === zone);
    if (!selectedZone)
      return err(new ValidationError('The selected Cloudflare zone is no longer available'));
    return ok({
      credential,
      zone,
      zoneStatus: selectedZone.status.toLowerCase(),
      normalized,
      config: settings.value.cloudflare,
    });
  }

  private async wait(
    record: CloudflareDnsRecord,
    expectedIp: string,
    timeoutSeconds: number,
    sslMode: string,
    zoneStatus: string,
  ): Promise<Result<CloudflareDnsPropagation, ServiceProviderError>> {
    const attempts = Math.max(1, Math.ceil(timeoutSeconds / 5));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const answers = await this.dns.resolve(record.name);
      const values = answers.ok ? answers.value : [];
      if (
        record.content === expectedIp &&
        (record.proxied
          ? zoneStatus === 'active' || values.length > 0
          : values.includes(expectedIp))
      )
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
          : status === 'pending'
            ? 'The Cloudflare origin record matches this VPS. Waiting for public edge DNS propagation.'
            : record.proxied
              ? answers.length > 0
                ? 'Cloudflare proxy is enabled; public DNS correctly returns Cloudflare edge addresses.'
                : 'Cloudflare confirms an active zone and a proxied origin record matching this VPS.'
              : null,
      sslMode,
      certificateRequirement:
        !record.proxied || sslMode === 'off' || sslMode === 'full' || sslMode === 'strict'
          ? 'required'
          : 'recommended',
    };
  }
}

type CloudflareDnsAutomationFailure =
  ServiceProviderError | ValidationError | ConflictError | CloudflareFailure;

function validIp(value: string): boolean {
  if (value.includes(':')) return /^[0-9a-f:]+$/i.test(value);
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
