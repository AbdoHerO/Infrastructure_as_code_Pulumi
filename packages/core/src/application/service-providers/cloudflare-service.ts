import {
  ConflictError,
  err,
  ServiceProviderError,
  ValidationError,
  type Result,
} from '@cloudforge/shared';
import type { CredentialService } from '../credentials/credential-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { ServiceProviderFactory } from '../ports/service-provider-factory.js';
import type { SettingsService } from '../settings/settings-service.js';
import type {
  CloudflareAnalytics,
  CloudflareDashboard,
  CloudflareDnsRecord,
  CloudflareDnsRecordInput,
  CloudflareDnsBatchAction,
  CloudflarePageRule,
  CloudflareRedirectRule,
  CloudflarePlatformSummary,
  CloudflareProvider,
  CloudflareSecurityOverview,
  CloudflareZone,
  CloudflareZoneSettings,
} from './cloudflare.js';
import type { ServiceConnection } from './service-provider.js';

type CloudflareFailure = ServiceProviderError | ValidationError | ConflictError;

export class CloudflareService {
  constructor(
    private readonly credentials: CredentialService,
    private readonly factory: ServiceProviderFactory,
    private readonly activities: ActivityService,
    private readonly settings?: SettingsService,
  ) {}

  async test(credentialId: string): Promise<Result<ServiceConnection, CloudflareFailure>> {
    return this.withProvider(credentialId, (provider) => provider.testConnection());
  }

  async zones(credentialId: string): Promise<Result<readonly CloudflareZone[], CloudflareFailure>> {
    return this.withProvider(credentialId, (provider) => provider.zones());
  }

  async createZone(
    credentialId: string,
    name: string,
    accountId?: string,
  ): Promise<Result<CloudflareZone, CloudflareFailure>> {
    const normalized = name.trim().toLowerCase();
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(normalized))
      return err(new ValidationError('Enter a valid zone domain'));
    const result = await this.withProvider(credentialId, (provider) =>
      provider.createZone(normalized, accountId?.trim()),
    );
    await this.record(
      result.ok ? 'cloudflare.zone.created' : 'cloudflare.zone.create_failed',
      `${result.ok ? 'Created' : 'Failed to create'} Cloudflare zone ${normalized}`,
      { zoneName: normalized },
    );
    return result;
  }

  async dashboard(
    credentialId: string,
    zoneId?: string,
  ): Promise<Result<CloudflareDashboard, CloudflareFailure>> {
    return this.withProvider(credentialId, (provider) => provider.dashboard(zoneId));
  }

  async dnsRecords(
    credentialId: string,
    zoneId: string,
  ): Promise<Result<readonly CloudflareDnsRecord[], CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    return this.withProvider(credentialId, (provider) => provider.dnsRecords(zone.value));
  }

  async createDnsRecord(
    credentialId: string,
    zoneId: string,
    input: CloudflareDnsRecordInput,
  ): Promise<Result<CloudflareDnsRecord, CloudflareFailure>> {
    const valid = validateDnsRecord(input);
    if (!valid.ok) return valid;
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    const current = await this.dnsRecords(credentialId, zone.value);
    if (!current.ok) return current;
    if (
      current.value.some(
        (record) =>
          record.type === valid.value.type &&
          record.name.toLowerCase() === valid.value.name &&
          record.content === valid.value.content,
      )
    )
      return err(new ConflictError('An identical Cloudflare DNS record already exists'));
    const result = await this.withProvider(credentialId, (provider) =>
      provider.createDnsRecord(zone.value, valid.value),
    );
    await this.record(
      result.ok ? 'cloudflare.dns.created' : 'cloudflare.dns.failed',
      `${result.ok ? 'Created' : 'Failed to create'} ${valid.value.type} record ${valid.value.name}`,
      { zoneId, type: valid.value.type, name: valid.value.name },
    );
    return result;
  }

  async updateDnsRecord(
    credentialId: string,
    zoneId: string,
    recordId: string,
    input: CloudflareDnsRecordInput,
  ): Promise<Result<CloudflareDnsRecord, CloudflareFailure>> {
    const valid = validateDnsRecord(input);
    if (!valid.ok) return valid;
    const zone = required(zoneId, 'Zone');
    const record = required(recordId, 'Record');
    if (!zone.ok) return zone;
    if (!record.ok) return record;
    const current = await this.dnsRecords(credentialId, zone.value);
    if (!current.ok) return current;
    if (
      current.value.some(
        (item) =>
          item.id !== record.value &&
          item.type === valid.value.type &&
          item.name.toLowerCase() === valid.value.name &&
          item.content === valid.value.content,
      )
    )
      return err(new ConflictError('An identical Cloudflare DNS record already exists'));
    const result = await this.withProvider(credentialId, (provider) =>
      provider.updateDnsRecord(zone.value, record.value, valid.value),
    );
    await this.record(
      result.ok ? 'cloudflare.dns.updated' : 'cloudflare.dns.failed',
      `${result.ok ? 'Updated' : 'Failed to update'} ${valid.value.type} record ${valid.value.name}`,
      { zoneId, recordId, type: valid.value.type, name: valid.value.name },
    );
    return result;
  }

  async deleteDnsRecord(
    credentialId: string,
    zoneId: string,
    recordId: string,
  ): Promise<Result<void, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    const record = required(recordId, 'Record');
    if (!zone.ok) return zone;
    if (!record.ok) return record;
    const result = await this.withProvider(credentialId, (provider) =>
      provider.deleteDnsRecord(zone.value, record.value),
    );
    await this.record(
      result.ok ? 'cloudflare.dns.deleted' : 'cloudflare.dns.failed',
      `${result.ok ? 'Deleted' : 'Failed to delete'} Cloudflare DNS record`,
      { zoneId, recordId },
    );
    return result;
  }

  async batchDnsRecords(
    credentialId: string,
    zoneId: string,
    action: CloudflareDnsBatchAction,
  ): Promise<Result<{ changed: number }, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    const ids = [...new Set(action.recordIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return err(new ValidationError('Select at least one DNS record'));
    const records = await this.dnsRecords(credentialId, zone.value);
    if (!records.ok) return records;
    const selected = records.value.filter((record) => ids.includes(record.id));
    if (selected.length !== ids.length)
      return err(new ValidationError('One or more selected DNS records no longer exist'));
    if (action.kind === 'ttl' && action.ttl !== 1 && (action.ttl < 60 || action.ttl > 86400))
      return err(new ValidationError('TTL must be Automatic (1) or between 60 and 86400 seconds'));
    if (
      action.kind === 'proxy' &&
      action.enabled &&
      selected.some((record) => !['A', 'AAAA', 'CNAME'].includes(record.type))
    )
      return err(new ValidationError('Only A, AAAA and CNAME records can be proxied'));

    for (const record of selected) {
      const result =
        action.kind === 'delete'
          ? await this.deleteDnsRecord(credentialId, zone.value, record.id)
          : await this.updateDnsRecord(credentialId, zone.value, record.id, {
              type: record.type,
              name: record.name,
              content: record.content,
              ttl: action.kind === 'ttl' ? action.ttl : record.ttl,
              proxied: action.kind === 'proxy' ? action.enabled : record.proxied,
              comment: record.comment,
              tags: record.tags,
              priority: record.priority,
            });
      if (!result.ok) return result;
    }
    await this.record('cloudflare.dns.batch_updated', `Updated ${selected.length} DNS records`, {
      zoneId,
      action: action.kind,
      count: selected.length,
    });
    return { ok: true, value: { changed: selected.length } };
  }

  async deleteZone(credentialId: string, zoneId: string): Promise<Result<void, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    const result = await this.withProvider(credentialId, (provider) =>
      provider.deleteZone(zone.value),
    );
    await this.record(
      result.ok ? 'cloudflare.zone.deleted' : 'cloudflare.zone.delete_failed',
      `${result.ok ? 'Deleted' : 'Failed to delete'} Cloudflare zone`,
      { zoneId },
    );
    return result;
  }

  async zoneSettings(
    credentialId: string,
    zoneId: string,
  ): Promise<Result<CloudflareZoneSettings, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    return this.withProvider(credentialId, (provider) => provider.zoneSettings(zone.value));
  }

  async updateZoneSettings(
    credentialId: string,
    zoneId: string,
    patch: Partial<CloudflareZoneSettings>,
  ): Promise<Result<CloudflareZoneSettings, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    const result = await this.withProvider(credentialId, (provider) =>
      provider.updateZoneSettings(zone.value, patch),
    );
    await this.record(
      result.ok ? 'cloudflare.ssl_cache.updated' : 'cloudflare.ssl_cache.failed',
      `${result.ok ? 'Updated' : 'Failed to update'} Cloudflare zone settings`,
      { zoneId, fields: Object.keys(patch) },
    );
    return result;
  }

  async purgeCache(credentialId: string, zoneId: string): Promise<Result<void, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    const result = await this.withProvider(credentialId, (provider) =>
      provider.purgeCache(zone.value),
    );
    await this.record(
      result.ok ? 'cloudflare.cache.purged' : 'cloudflare.cache.purge_failed',
      `${result.ok ? 'Purged' : 'Failed to purge'} Cloudflare cache`,
      { zoneId },
    );
    return result;
  }

  async security(
    credentialId: string,
    zoneId: string,
  ): Promise<Result<CloudflareSecurityOverview, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    return this.withProvider(credentialId, (provider) => provider.security(zone.value));
  }

  async analytics(
    credentialId: string,
    zoneId: string,
    since: string,
    until: string,
  ): Promise<Result<CloudflareAnalytics, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    const start = required(since, 'Since');
    const end = required(until, 'Until');
    if (!zone.ok) return zone;
    if (!start.ok) return start;
    if (!end.ok) return end;
    return this.withProvider(credentialId, (provider) =>
      provider.analytics(zone.value, start.value, end.value),
    );
  }

  async pageRules(
    credentialId: string,
    zoneId: string,
  ): Promise<Result<readonly CloudflarePageRule[], CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    return this.withProvider(credentialId, (provider) => provider.pageRules(zone.value));
  }

  async savePageRule(
    credentialId: string,
    zoneId: string,
    rule: CloudflarePageRule | Omit<CloudflarePageRule, 'id'>,
  ): Promise<Result<CloudflarePageRule, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    const result = await this.withProvider(credentialId, (provider) =>
      'id' in rule
        ? provider.updatePageRule(zone.value, rule)
        : provider.createPageRule(zone.value, rule),
    );
    await this.record(
      result.ok ? 'cloudflare.page_rule.saved' : 'cloudflare.page_rule.failed',
      `${result.ok ? 'Saved' : 'Failed to save'} Cloudflare page rule`,
      { zoneId },
    );
    return result;
  }

  async deletePageRule(
    credentialId: string,
    zoneId: string,
    ruleId: string,
  ): Promise<Result<void, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    const id = required(ruleId, 'Page rule');
    if (!zone.ok) return zone;
    if (!id.ok) return id;
    const result = await this.withProvider(credentialId, (provider) =>
      provider.deletePageRule(zone.value, id.value),
    );
    await this.record(
      result.ok ? 'cloudflare.page_rule.deleted' : 'cloudflare.page_rule.failed',
      `${result.ok ? 'Deleted' : 'Failed to delete'} Cloudflare page rule`,
      { zoneId, ruleId },
    );
    return result;
  }

  async redirectRules(
    credentialId: string,
    zoneId: string,
  ): Promise<Result<readonly CloudflareRedirectRule[], CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    return this.withProvider(credentialId, (provider) => provider.redirectRules(zone.value));
  }

  async saveRedirectRule(
    credentialId: string,
    zoneId: string,
    rule: CloudflareRedirectRule | Omit<CloudflareRedirectRule, 'id'>,
  ): Promise<Result<CloudflareRedirectRule, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    if (!zone.ok) return zone;
    if (!rule.source.trim())
      return err(new ValidationError('Redirect source expression is required'));
    try {
      const destination = new URL(rule.destination);
      if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('protocol');
    } catch {
      return err(new ValidationError('Redirect destination must be an HTTP or HTTPS URL'));
    }
    const result = await this.withProvider(credentialId, (provider) =>
      provider.saveRedirectRule(zone.value, {
        ...rule,
        source: rule.source.trim(),
        destination: rule.destination.trim(),
      }),
    );
    await this.record(
      result.ok ? 'cloudflare.redirect.saved' : 'cloudflare.redirect.failed',
      `${result.ok ? 'Saved' : 'Failed to save'} Cloudflare redirect`,
      { zoneId },
    );
    return result;
  }

  async deleteRedirectRule(
    credentialId: string,
    zoneId: string,
    ruleId: string,
  ): Promise<Result<void, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    const id = required(ruleId, 'Redirect rule');
    if (!zone.ok) return zone;
    if (!id.ok) return id;
    const result = await this.withProvider(credentialId, (provider) =>
      provider.deleteRedirectRule(zone.value, id.value),
    );
    await this.record(
      result.ok ? 'cloudflare.redirect.deleted' : 'cloudflare.redirect.failed',
      `${result.ok ? 'Deleted' : 'Failed to delete'} Cloudflare redirect`,
      { zoneId, ruleId },
    );
    return result;
  }

  async platform(
    credentialId: string,
    zoneId: string,
    accountId: string,
  ): Promise<Result<CloudflarePlatformSummary, CloudflareFailure>> {
    const zone = required(zoneId, 'Zone');
    const account = required(accountId, 'Account');
    if (!zone.ok) return zone;
    if (!account.ok) return account;
    return this.withProvider(credentialId, (provider) =>
      provider.platform(zone.value, account.value),
    );
  }

  private async withProvider<T>(
    credentialId: string,
    operation: (provider: CloudflareProvider) => Promise<Result<T, ServiceProviderError>>,
  ): Promise<Result<T, CloudflareFailure>> {
    const credential = await this.credentials.getDecrypted(credentialId);
    if (!credential.ok)
      return err(
        new ServiceProviderError('Could not decrypt the Cloudflare credential', {
          cause: credential.error,
        }),
      );
    if (credential.value.kind !== 'cloudflare')
      return err(new ValidationError('Select a Cloudflare credential'));
    const created = this.factory.create('cloudflare', credential.value.data);
    if (!created.ok) return created;
    if (created.value.kind !== 'cloudflare')
      return err(
        new ServiceProviderError('The service provider factory returned the wrong adapter'),
      );
    return operation(created.value as CloudflareProvider);
  }

  private async record(
    type: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (this.settings) {
      const settings = await this.settings.get();
      if (settings.ok && !settings.value.cloudflare.activityLogging) return;
    }
    this.activities.recordSafe({ type, message, metadata });
  }
}

function required(value: string, label: string): Result<string, ValidationError> {
  const normalized = value.trim();
  return normalized
    ? { ok: true, value: normalized }
    : err(new ValidationError(`${label} is required`));
}

const HOST =
  /^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/i;
export function validateDnsRecord(
  input: CloudflareDnsRecordInput,
): Result<CloudflareDnsRecordInput, ValidationError> {
  const name = input.name.trim().toLowerCase();
  const content = input.content.trim();
  if (!name || !HOST.test(name)) return err(new ValidationError('Enter a valid DNS record name'));
  if (!content || /[\r\n\0]/.test(content))
    return err(new ValidationError('DNS record content is required'));
  if (
    (input.type === 'A' && !validIpv4(content)) ||
    (input.type === 'AAAA' && !content.includes(':'))
  )
    return err(new ValidationError(`Enter a valid ${input.type} address`));
  if (input.type === 'CNAME' && (!HOST.test(content) || content === name))
    return err(new ValidationError('Enter a valid CNAME target different from the record name'));
  if (input.ttl !== 1 && (input.ttl < 60 || input.ttl > 86400 || !Number.isInteger(input.ttl)))
    return err(new ValidationError('TTL must be Automatic (1) or between 60 and 86400 seconds'));
  if (input.proxied && !['A', 'AAAA', 'CNAME'].includes(input.type))
    return err(new ValidationError(`${input.type} records cannot be proxied`));
  if (
    input.priority !== undefined &&
    input.priority !== null &&
    (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 65535)
  )
    return err(new ValidationError('DNS record priority must be between 0 and 65535'));
  return {
    ok: true,
    value: {
      ...input,
      name,
      content,
      ...(input.comment !== undefined ? { comment: input.comment.trim().slice(0, 100) } : {}),
      ...(input.tags !== undefined
        ? {
            tags: input.tags
              .map((tag) => tag.trim())
              .filter(Boolean)
              .slice(0, 20),
          }
        : {}),
    },
  };
}

function validIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
