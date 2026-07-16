import { err, ok, ServiceProviderError, type Result } from '@cloudforge/shared';
import type {
  CloudflareAccount,
  CloudflareAnalytics,
  CloudflareDashboard,
  CloudflareDnsRecord,
  CloudflareDnsRecordInput,
  CloudflarePageRule,
  CloudflareOriginCertificate,
  CloudflareOriginCertificateInput,
  CloudflareRedirectRule,
  CloudflarePlatformSummary,
  CloudflareProvider,
  CloudflareSecurityOverview,
  CloudflareZone,
  CloudflareZoneSettings,
  ProviderCredentials,
  ServiceConnection,
} from '@cloudforge/core';

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: readonly { code: number; message: string }[];
  result_info?: { page: number; total_pages: number };
}
interface RawZone {
  id: string;
  name: string;
  status: string;
  development_mode?: number;
  name_servers?: string[];
  created_on?: string;
  account?: { id: string; name: string };
  plan?: { name: string };
}
interface RawRecord {
  id: string;
  zone_id: string;
  type: CloudflareDnsRecord['type'];
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  proxiable?: boolean;
  comment?: string;
  tags?: string[];
  priority?: number;
  created_on?: string;
  modified_on?: string;
}
interface RawSetting {
  id: string;
  value: unknown;
}
interface RawPageRule {
  id: string;
  targets?: readonly { target: string; constraint?: { value?: string } }[];
  actions?: readonly { id: string; value: unknown }[];
  priority?: number;
  status?: 'active' | 'disabled';
}
interface RawRedirectRule {
  id?: string;
  ref?: string;
  expression: string;
  description?: string;
  enabled?: boolean;
  action: 'redirect';
  action_parameters: {
    from_value: {
      target_url: { value?: string };
      status_code?: number;
      preserve_query_string?: boolean;
    };
  };
}
interface RawRedirectRuleset {
  id: string;
  name: string;
  kind: string;
  phase: string;
  rules: readonly RawRedirectRule[];
}
interface RawOriginCertificate {
  id: string;
  certificate: string;
  hostnames: string[];
  expires_on: string;
  request_type: 'origin-rsa' | 'origin-ecc';
}

export interface CloudflareApiTransport {
  request<T>(path: string, init?: RequestInit): Promise<Result<T, ServiceProviderError>>;
  graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Result<T, ServiceProviderError>>;
}

export class CloudflareApiProvider implements CloudflareProvider {
  readonly kind = 'cloudflare' as const;
  private constructor(
    private readonly api: CloudflareApiTransport,
    private readonly accountId?: string,
    private readonly defaultZone?: string,
  ) {}

  static fromCredentials(
    credentials: ProviderCredentials,
    baseUrl: string,
  ): Result<CloudflareApiProvider, ServiceProviderError> {
    const token = credentials.apiToken?.trim();
    if (!token) return err(new ServiceProviderError('Cloudflare API Token is required'));
    return ok(
      new CloudflareApiProvider(
        new FetchCloudflareTransport(baseUrl, token),
        credentials.accountId?.trim(),
        credentials.defaultZone?.trim(),
      ),
    );
  }

  /** Adapter seam used by deterministic service and contract tests. */
  static fromTransport(
    api: CloudflareApiTransport,
    accountId?: string,
    defaultZone?: string,
  ): CloudflareApiProvider {
    return new CloudflareApiProvider(api, accountId, defaultZone);
  }

  async testConnection(): Promise<Result<ServiceConnection, ServiceProviderError>> {
    const zones = await this.zones();
    if (!zones.ok) return zones;
    const account = await this.accountFromZones(zones.value);
    if (!account.ok) return account;
    const warnings: string[] = [];
    const firstZone = zones.value[0];
    if (firstZone) {
      const dns = await this.dnsRecords(firstZone.id);
      if (!dns.ok) {
        warnings.push(
          `DNS access is unavailable for ${firstZone.name}. Add a Zone resource policy with DNS Read/Edit; account-only permissions do not grant access to zone DNS records.`,
        );
      }
    }
    return ok({
      // Reading the account and its zones is the capability CloudForge actually
      // needs. It also works for both user-owned and account-owned API tokens;
      // their dedicated token-verification endpoints are not interchangeable.
      connected: true,
      provider: this.kind,
      message:
        warnings.length === 0
          ? `Connected to ${account.value.name} · ${zones.value.length} zone(s)`
          : `Connected to ${account.value.name}, but DNS permissions are limited`,
      ...(warnings.length > 0 ? { warnings } : {}),
      account: { id: account.value.id, name: account.value.name },
      zones: zones.value.map((zone) => ({
        id: zone.id,
        name: zone.name,
        plan: zone.plan,
        status: zone.status,
      })),
    });
  }

  async account(): Promise<Result<CloudflareAccount, ServiceProviderError>> {
    const zones = await this.zones();
    if (!zones.ok) return zones;
    return this.accountFromZones(zones.value);
  }

  private async accountFromZones(
    zones: readonly CloudflareZone[],
  ): Promise<Result<CloudflareAccount, ServiceProviderError>> {
    const zone = this.accountId
      ? zones.find((item) => item.accountId === this.accountId)
      : zones.find((item) => Boolean(item.accountId));
    if (zone?.accountId) {
      const user = await this.api.request<{ email?: string }>('/user');
      return ok({
        id: zone.accountId,
        name: zone.accountName || 'Cloudflare account',
        email: user.ok ? (user.value.email ?? null) : null,
      });
    }

    // A valid account-scoped token can have no zones yet. When an Account ID
    // was configured explicitly, preserve that identity after the successful
    // zone capability check instead of incorrectly requiring account listing.
    if (this.accountId) {
      const user = await this.api.request<{ email?: string }>('/user');
      return ok({
        id: this.accountId,
        name: 'Cloudflare account',
        email: user.ok ? (user.value.email ?? null) : null,
      });
    }

    // Legacy global API keys may still enumerate accounts. Keep this fallback
    // for backward compatibility, but Bearer API tokens do not depend on it.
    const accounts =
      await this.api.request<readonly { id: string; name: string }[]>('/accounts?per_page=50');
    if (!accounts.ok) return accounts;
    const selected = accounts.value[0];
    if (!selected)
      return err(new ServiceProviderError('No Cloudflare account is available to this token'));
    const user = await this.api.request<{ email?: string }>('/user');
    return ok({
      id: selected.id,
      name: selected.name,
      email: user.ok ? (user.value.email ?? null) : null,
    });
  }

  async zones(): Promise<Result<readonly CloudflareZone[], ServiceProviderError>> {
    const query = new URLSearchParams({
      per_page: '50',
      ...(this.accountId ? { 'account.id': this.accountId } : {}),
    });
    const zones = await this.api.request<readonly RawZone[]>(`/zones?${query.toString()}`);
    return zones.ok ? ok(zones.value.map(mapZone)) : zones;
  }

  async deleteZone(zoneId: string): Promise<Result<void, ServiceProviderError>> {
    return this.api.request<void>(route('zones', zoneId), { method: 'DELETE' });
  }

  async createZone(
    name: string,
    accountId?: string,
  ): Promise<Result<CloudflareZone, ServiceProviderError>> {
    let resolvedAccountId = nonEmpty(accountId) ?? this.accountId;
    if (!resolvedAccountId) {
      const account = await this.account();
      if (!account.ok) return account;
      resolvedAccountId = account.value.id;
    }
    if (!resolvedAccountId)
      return err(new ServiceProviderError('A Cloudflare Account ID is required to add a zone'));
    const created = await this.api.request<RawZone>(
      '/zones',
      json('POST', { name, account: { id: resolvedAccountId }, type: 'full' }),
    );
    return created.ok ? ok(mapZone(created.value)) : created;
  }

  async dashboard(zoneId?: string): Promise<Result<CloudflareDashboard, ServiceProviderError>> {
    const zones = await this.zones();
    if (!zones.ok) return zones;
    const account = await this.accountFromZones(zones.value);
    if (!account.ok) return account;
    const zone = zoneId
      ? zones.value.find((item) => item.id === zoneId)
      : (zones.value.find(
          (item) => item.id === this.defaultZone || item.name === this.defaultZone,
        ) ?? zones.value[0]);
    const [records, settings, security, pages] = zone
      ? await Promise.all([
          this.dnsRecords(zone.id),
          this.zoneSettings(zone.id),
          this.security(zone.id),
          this.pageRules(zone.id),
        ])
      : ([ok([]), ok(null), ok(null), ok([])] as const);
    const warnings = [
      ...(!records.ok ? [`DNS: ${records.error.message}`] : []),
      ...(!settings.ok ? [`SSL and cache: ${settings.error.message}`] : []),
      ...(!security.ok ? [`Security: ${security.error.message}`] : []),
      ...(!pages.ok ? [`Page Rules: ${pages.error.message}`] : []),
    ];
    return ok({
      account: account.value,
      connected: true,
      apiStatus: warnings.length === 0 ? 'operational' : 'limited permissions',
      zones: zones.value.length,
      dnsRecords: records.ok ? records.value.length : null,
      plan: zone?.plan ?? '—',
      sslMode: settings.ok && settings.value ? settings.value.sslMode : '—',
      proxiedRecords: records.ok ? records.value.filter((item) => item.proxied).length : null,
      firewallRules: security.ok && security.value ? security.value.rules.length : null,
      pageRules: pages.ok ? pages.value.length : null,
      cacheStatus: settings.ok && settings.value ? settings.value.cacheLevel : 'Unavailable',
      lastSynchronization: new Date().toISOString(),
      warnings,
    });
  }

  async dnsRecords(
    zoneId: string,
  ): Promise<Result<readonly CloudflareDnsRecord[], ServiceProviderError>> {
    const records = await this.api.request<readonly RawRecord[]>(
      `${route('zones', zoneId, 'dns_records')}?per_page=500`,
    );
    return records.ok ? ok(records.value.map(mapRecord)) : records;
  }
  async createDnsRecord(
    zoneId: string,
    input: CloudflareDnsRecordInput,
  ): Promise<Result<CloudflareDnsRecord, ServiceProviderError>> {
    const result = await this.api.request<RawRecord>(
      route('zones', zoneId, 'dns_records'),
      json('POST', dnsBody(input)),
    );
    return result.ok ? ok(mapRecord(result.value)) : result;
  }
  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    input: CloudflareDnsRecordInput,
  ): Promise<Result<CloudflareDnsRecord, ServiceProviderError>> {
    const result = await this.api.request<RawRecord>(
      route('zones', zoneId, 'dns_records', recordId),
      json('PUT', dnsBody(input)),
    );
    return result.ok ? ok(mapRecord(result.value)) : result;
  }
  deleteDnsRecord(zoneId: string, recordId: string): Promise<Result<void, ServiceProviderError>> {
    return this.api.request<void>(route('zones', zoneId, 'dns_records', recordId), {
      method: 'DELETE',
    });
  }

  async zoneSettings(
    zoneId: string,
  ): Promise<Result<CloudflareZoneSettings, ServiceProviderError>> {
    const result = await this.api.request<readonly RawSetting[]>(
      route('zones', zoneId, 'settings'),
    );
    if (!result.ok) return result;
    const value = (id: string): unknown => result.value.find((item) => item.id === id)?.value;
    return ok({
      sslMode: oneOf(value('ssl'), ['off', 'flexible', 'full', 'strict'], 'off'),
      minimumTls: oneOf(value('min_tls_version'), ['1.0', '1.1', '1.2', '1.3'], '1.2'),
      tls13: value('tls_1_3') === 'on' || value('tls_1_3') === 'zrt',
      hsts: securityHeaderHsts(value('security_header')),
      alwaysHttps: value('always_use_https') === 'on',
      automaticHttpsRewrites: value('automatic_https_rewrites') === 'on',
      brotli: value('brotli') === 'on',
      developmentMode: value('development_mode') === 'on',
      securityLevel: safeString(value('security_level'), 'medium'),
      browserIntegrityCheck: value('browser_check') === 'on',
      cacheLevel: safeString(value('cache_level'), 'aggressive'),
      browserCacheTtl: Number(value('browser_cache_ttl') ?? 14400),
    });
  }

  async updateZoneSettings(
    zoneId: string,
    patch: Partial<CloudflareZoneSettings>,
  ): Promise<Result<CloudflareZoneSettings, ServiceProviderError>> {
    const mapping: Record<keyof CloudflareZoneSettings, [string, (value: unknown) => unknown]> = {
      sslMode: ['ssl', (v) => v],
      minimumTls: ['min_tls_version', (v) => v],
      tls13: ['tls_1_3', (v) => (v ? 'on' : 'off')],
      hsts: [
        'security_header',
        (v) => ({
          strict_transport_security: {
            enabled: Boolean(v),
            include_subdomains: true,
            preload: false,
            max_age: 15552000,
            nosniff: true,
          },
        }),
      ],
      alwaysHttps: ['always_use_https', (v) => (v ? 'on' : 'off')],
      automaticHttpsRewrites: ['automatic_https_rewrites', (v) => (v ? 'on' : 'off')],
      brotli: ['brotli', (v) => (v ? 'on' : 'off')],
      developmentMode: ['development_mode', (v) => (v ? 'on' : 'off')],
      securityLevel: ['security_level', (v) => v],
      browserIntegrityCheck: ['browser_check', (v) => (v ? 'on' : 'off')],
      cacheLevel: ['cache_level', (v) => v],
      browserCacheTtl: ['browser_cache_ttl', (v) => v],
    };
    for (const [key, raw] of Object.entries(patch) as [keyof CloudflareZoneSettings, unknown][]) {
      const pair = mapping[key];
      if (!pair) continue;
      const [setting, convert] = pair;
      const saved = await this.api.request(
        route('zones', zoneId, 'settings', setting),
        json('PATCH', { value: convert(raw) }),
      );
      if (!saved.ok) return saved;
    }
    return this.zoneSettings(zoneId);
  }
  purgeCache(zoneId: string): Promise<Result<void, ServiceProviderError>> {
    return this.api.request<void>(
      route('zones', zoneId, 'purge_cache'),
      json('POST', { purge_everything: true }),
    );
  }

  async security(
    zoneId: string,
  ): Promise<Result<CloudflareSecurityOverview, ServiceProviderError>> {
    const [settings, rulesets, rateLimits, countryBlocks, ipLists, bot] = await Promise.all([
      this.zoneSettings(zoneId),
      this.api.request<readonly { id: string; name: string; phase: string; kind: string }[]>(
        route('zones', zoneId, 'rulesets'),
      ),
      this.api.request<readonly { id: string }[]>(
        `${route('zones', zoneId, 'rate_limits')}?per_page=50`,
      ),
      this.api.request<readonly { id: string }[]>(
        `${route('zones', zoneId, 'firewall', 'access_rules', 'rules')}?configuration.target=country&per_page=50`,
      ),
      this.accountId
        ? this.api.request<readonly { id: string }[]>(
            `${route('accounts', this.accountId, 'rules', 'lists')}?per_page=50`,
          )
        : Promise.resolve(ok([])),
      this.api.request<{ fight_mode?: boolean; ai_bots_protection?: string }>(
        route('zones', zoneId, 'bot_management'),
      ),
    ]);
    if (!settings.ok) return settings;
    return ok({
      wafStatus: rulesets.ok ? 'available' : 'unavailable for token/plan',
      securityLevel: settings.value.securityLevel,
      browserIntegrityCheck: settings.value.browserIntegrityCheck,
      underAttackMode: settings.value.securityLevel === 'under_attack',
      rules: rulesets.ok
        ? rulesets.value.map((item) => ({
            id: item.id,
            name: item.name,
            phase: item.phase,
            status: item.kind,
          }))
        : [],
      rateLimits: rateLimits.ok ? rateLimits.value.length : 0,
      ipLists: ipLists.ok ? ipLists.value.length : 0,
      countryBlocks: countryBlocks.ok ? countryBlocks.value.length : 0,
      ddosStatus: 'Cloudflare managed',
      botProtection: bot.ok
        ? bot.value.fight_mode
          ? 'Bot Fight Mode'
          : (bot.value.ai_bots_protection ?? 'configured')
        : 'unavailable for token/plan',
    });
  }

  async analytics(
    zoneId: string,
    since: string,
    until: string,
  ): Promise<Result<CloudflareAnalytics, ServiceProviderError>> {
    const result = await this.api.graphql<CloudflareAnalyticsGraphql>(ANALYTICS_QUERY, {
      zone: zoneId,
      dateStart: since.slice(0, 10),
      dateEnd: until.slice(0, 10),
      datetimeStart: since,
      datetimeEnd: until,
    });
    if (!result.ok) return result;
    const zone = result.value.viewer.zones[0];
    const series = zone?.daily ?? [];
    return ok({
      since,
      until,
      requests: sum(series, (item) => item.sum.requests),
      cachedRequests: sum(series, (item) => item.sum.cachedRequests),
      bandwidth: sum(series, (item) => item.sum.bytes),
      threats: sum(series, (item) => item.sum.threats),
      visitors: sum(series, (item) => item.uniq.uniques),
      series: series.map((item) => ({
        date: item.dimensions.date,
        requests: item.sum.requests,
        bandwidth: item.sum.bytes,
        cachedRequests: item.sum.cachedRequests,
        threats: item.sum.threats,
        visitors: item.uniq.uniques,
      })),
      countries: (zone?.countries ?? []).map((item) => ({
        name: item.dimensions.clientCountryName,
        requests: item.count,
      })),
      topUrls: (zone?.urls ?? []).map((item) => ({
        path: item.dimensions.clientRequestPath,
        requests: item.count,
      })),
      statusCodes: (zone?.statuses ?? []).map((item) => ({
        status: item.dimensions.edgeResponseStatus,
        requests: item.count,
      })),
    });
  }

  async pageRules(
    zoneId: string,
  ): Promise<Result<readonly CloudflarePageRule[], ServiceProviderError>> {
    const result = await this.api.request<readonly RawPageRule[]>(
      `${route('zones', zoneId, 'pagerules')}?order=priority`,
    );
    return result.ok ? ok(result.value.map(mapPageRule)) : result;
  }
  async createPageRule(
    zoneId: string,
    input: Omit<CloudflarePageRule, 'id'>,
  ): Promise<Result<CloudflarePageRule, ServiceProviderError>> {
    const result = await this.api.request<RawPageRule>(
      route('zones', zoneId, 'pagerules'),
      json('POST', pageRuleBody(input)),
    );
    return result.ok ? ok(mapPageRule(result.value)) : result;
  }
  async updatePageRule(
    zoneId: string,
    rule: CloudflarePageRule,
  ): Promise<Result<CloudflarePageRule, ServiceProviderError>> {
    const result = await this.api.request<RawPageRule>(
      route('zones', zoneId, 'pagerules', rule.id),
      json('PUT', pageRuleBody(rule)),
    );
    return result.ok ? ok(mapPageRule(result.value)) : result;
  }
  deletePageRule(zoneId: string, ruleId: string): Promise<Result<void, ServiceProviderError>> {
    return this.api.request<void>(route('zones', zoneId, 'pagerules', ruleId), {
      method: 'DELETE',
    });
  }

  async redirectRules(
    zoneId: string,
  ): Promise<Result<readonly CloudflareRedirectRule[], ServiceProviderError>> {
    const ruleset = await this.redirectRuleset(zoneId);
    return ruleset.ok ? ok(ruleset.value?.rules.map(mapRedirectRule) ?? []) : ruleset;
  }

  async saveRedirectRule(
    zoneId: string,
    rule: CloudflareRedirectRule | Omit<CloudflareRedirectRule, 'id'>,
  ): Promise<Result<CloudflareRedirectRule, ServiceProviderError>> {
    const loaded = await this.redirectRuleset(zoneId);
    if (!loaded.ok) return loaded;
    const raw = redirectRuleBody(rule);
    const existing = loaded.value?.rules ?? [];
    const rules =
      'id' in rule
        ? existing.map((item) =>
            item.id === rule.id ? raw : redirectRuleBody(mapRedirectRule(item)),
          )
        : [...existing.map((item) => redirectRuleBody(mapRedirectRule(item))), raw];
    const saved = loaded.value
      ? await this.api.request<RawRedirectRuleset>(
          route('zones', zoneId, 'rulesets', loaded.value.id),
          json('PUT', {
            name: loaded.value.name,
            kind: loaded.value.kind,
            phase: loaded.value.phase,
            rules,
          }),
        )
      : await this.api.request<RawRedirectRuleset>(
          route('zones', zoneId, 'rulesets'),
          json('POST', {
            name: 'CloudForge Redirect Rules',
            kind: 'zone',
            phase: 'http_request_dynamic_redirect',
            rules,
          }),
        );
    if (!saved.ok) return saved;
    const match = saved.value.rules.find(
      (item) =>
        item.expression === rule.source &&
        item.action_parameters.from_value.target_url.value === rule.destination,
    );
    return match
      ? ok(mapRedirectRule(match))
      : err(
          new ServiceProviderError(
            'Cloudflare saved the ruleset but did not return the redirect rule',
          ),
        );
  }

  async deleteRedirectRule(
    zoneId: string,
    ruleId: string,
  ): Promise<Result<void, ServiceProviderError>> {
    const loaded = await this.redirectRuleset(zoneId);
    if (!loaded.ok) return loaded;
    if (!loaded.value) return ok(undefined);
    const rules = loaded.value.rules
      .filter((item) => item.id !== ruleId)
      .map((item) => redirectRuleBody(mapRedirectRule(item)));
    const saved = await this.api.request<RawRedirectRuleset>(
      route('zones', zoneId, 'rulesets', loaded.value.id),
      json('PUT', {
        name: loaded.value.name,
        kind: loaded.value.kind,
        phase: loaded.value.phase,
        rules,
      }),
    );
    return saved.ok ? ok(undefined) : saved;
  }

  private async redirectRuleset(
    zoneId: string,
  ): Promise<Result<RawRedirectRuleset | null, ServiceProviderError>> {
    const result = await this.api.request<RawRedirectRuleset>(
      route('zones', zoneId, 'rulesets', 'phases', 'http_request_dynamic_redirect', 'entrypoint'),
    );
    if (!result.ok && result.error.context?.status === 404) return ok(null);
    return result;
  }

  async platform(
    zoneId: string,
    accountId: string,
  ): Promise<Result<CloudflarePlatformSummary, ServiceProviderError>> {
    const apps = await this.api.request<readonly { id: string; name: string; domain: string }[]>(
      route('accounts', accountId, 'access', 'apps'),
    );
    const [workers, routes, buckets, gatewayRules, policies] = await Promise.all([
      this.api.request<readonly { id: string; created_on?: string; modified_on?: string }[]>(
        route('accounts', accountId, 'workers', 'scripts'),
      ),
      this.api.request<readonly { id: string; pattern: string; script?: string }[]>(
        route('zones', zoneId, 'workers', 'routes'),
      ),
      this.api.request<{
        buckets?: readonly {
          name: string;
          creation_date?: string;
          object_count?: number;
          size?: number;
        }[];
      }>(route('accounts', accountId, 'r2', 'buckets')),
      this.api.request<readonly { id: string; name: string; enabled?: boolean }[]>(
        route('accounts', accountId, 'gateway', 'rules'),
      ),
      apps.ok
        ? Promise.all(
            apps.value.map(async (application) => ({
              application,
              result: await this.api.request<
                readonly { id: string; name: string; decision: string }[]
              >(route('accounts', accountId, 'access', 'apps', application.id, 'policies')),
            })),
          )
        : Promise.resolve([]),
    ]);
    return ok({
      workers: workers.ok
        ? workers.value.map((item) => ({
            id: item.id,
            status: 'deployed',
            createdAt: item.created_on ?? '',
            modifiedAt: item.modified_on ?? '',
          }))
        : [],
      workerRoutes: routes.ok
        ? routes.value.map((item) => ({
            id: item.id,
            pattern: item.pattern,
            script: item.script ?? null,
          }))
        : [],
      r2Buckets: buckets.ok
        ? (buckets.value.buckets ?? []).map((item) => ({
            name: item.name,
            createdAt: item.creation_date ?? '',
            objectCount: item.object_count ?? null,
            sizeBytes: item.size ?? null,
          }))
        : [],
      accessApplications: apps.ok ? apps.value : [],
      accessPolicies: policies.flatMap(({ application, result }) =>
        result.ok
          ? result.value.map((policy) => ({
              ...policy,
              applicationId: application.id,
            }))
          : [],
      ),
      gatewayRules: gatewayRules.ok
        ? gatewayRules.value.map((rule) => ({
            id: rule.id,
            name: rule.name,
            enabled: rule.enabled ?? true,
          }))
        : [],
    });
  }

  async createOriginCertificate(
    input: CloudflareOriginCertificateInput,
  ): Promise<Result<CloudflareOriginCertificate, ServiceProviderError>> {
    const result = await this.api.request<RawOriginCertificate>(
      '/certificates',
      json('POST', {
        csr: input.csr,
        hostnames: input.hostnames,
        request_type: input.requestType,
        requested_validity: input.validityDays,
      }),
    );
    return result.ok
      ? ok({
          id: result.value.id,
          certificate: result.value.certificate,
          hostnames: result.value.hostnames,
          expiresAt: result.value.expires_on,
          requestType: result.value.request_type,
        })
      : result;
  }
}

class FetchCloudflareTransport implements CloudflareApiTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<Result<T, ServiceProviderError>> {
    try {
      const response = await fetch(
        new URL(path.replace(/^\//, ''), `${this.baseUrl.replace(/\/$/, '')}/`),
        {
          ...init,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json',
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...init.headers,
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      const payload = (await response.json()) as Envelope<T>;
      if (!response.ok || !payload.success) {
        const messages = payload.errors?.map((item) => item.message).join('; ');
        return err(
          new ServiceProviderError(
            `Cloudflare API ${response.status}: ${nonEmpty(messages) ?? response.statusText}`,
            {
              context: { status: response.status, codes: payload.errors?.map((item) => item.code) },
            },
          ),
        );
      }
      return ok(payload.result);
    } catch (cause) {
      return err(new ServiceProviderError('Cloudflare API request failed', { cause }));
    }
  }

  async graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Result<T, ServiceProviderError>> {
    try {
      const response = await fetch(new URL('graphql', `${this.baseUrl.replace(/\/$/, '')}/`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await response.json()) as {
        data?: T;
        errors?: readonly { message: string }[];
      };
      if (!response.ok || !payload.data)
        return err(
          new ServiceProviderError(
            `Cloudflare Analytics API ${response.status}: ${payload.errors?.map((item) => item.message).join('; ') ?? response.statusText}`,
            { context: { status: response.status } },
          ),
        );
      return ok(payload.data);
    } catch (cause) {
      return err(new ServiceProviderError('Cloudflare Analytics request failed', { cause }));
    }
  }
}

interface CloudflareAnalyticsGraphql {
  viewer: {
    zones: readonly {
      daily: readonly {
        dimensions: { date: string };
        sum: { requests: number; bytes: number; cachedRequests: number; threats: number };
        uniq: { uniques: number };
      }[];
      countries: readonly { count: number; dimensions: { clientCountryName: string } }[];
      urls: readonly { count: number; dimensions: { clientRequestPath: string } }[];
      statuses: readonly { count: number; dimensions: { edgeResponseStatus: number } }[];
    }[];
  };
}

const ANALYTICS_QUERY = `query CloudForgeAnalytics($zone: String!, $dateStart: Date!, $dateEnd: Date!, $datetimeStart: Time!, $datetimeEnd: Time!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    daily: httpRequests1dGroups(limit: 31, filter: { date_geq: $dateStart, date_leq: $dateEnd }, orderBy: [date_ASC]) { dimensions { date } sum { requests bytes cachedRequests threats } uniq { uniques } }
    countries: httpRequestsAdaptiveGroups(limit: 10, filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }, orderBy: [count_DESC]) { count dimensions { clientCountryName } }
    urls: httpRequestsAdaptiveGroups(limit: 10, filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }, orderBy: [count_DESC]) { count dimensions { clientRequestPath } }
    statuses: httpRequestsAdaptiveGroups(limit: 10, filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }, orderBy: [count_DESC]) { count dimensions { edgeResponseStatus } }
  } }
}`;

function route(...parts: string[]): string {
  return `/${parts.map(encodeURIComponent).join('/')}`;
}
function json(method: string, value: unknown): RequestInit {
  return { method, body: JSON.stringify(value) };
}
function mapZone(value: RawZone): CloudflareZone {
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    plan: value.plan?.name ?? 'Unknown',
    developmentMode: value.development_mode ?? 0,
    nameServers: value.name_servers ?? [],
    createdAt: value.created_on ?? '',
    accountId: value.account?.id ?? '',
    accountName: value.account?.name ?? '',
  };
}
function mapRecord(value: RawRecord): CloudflareDnsRecord {
  return {
    id: value.id,
    zoneId: value.zone_id,
    type: value.type,
    name: value.name,
    content: value.content,
    ttl: value.ttl,
    proxied: value.proxied ?? false,
    proxiable: value.proxiable ?? false,
    comment: value.comment ?? '',
    tags: value.tags ?? [],
    priority: value.priority ?? null,
    createdAt: value.created_on ?? '',
    modifiedAt: value.modified_on ?? '',
  };
}
function dnsBody(input: CloudflareDnsRecordInput): object {
  return {
    type: input.type,
    name: input.name,
    content: input.content,
    ttl: input.ttl,
    proxied: input.proxied,
    ...(input.comment ? { comment: input.comment } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.priority !== null && input.priority !== undefined
      ? { priority: input.priority }
      : {}),
  };
}
function pageRuleBody(rule: Omit<CloudflarePageRule, 'id'>): object {
  return {
    targets: [{ target: 'url', constraint: { operator: 'matches', value: rule.target } }],
    actions: rule.actions,
    priority: rule.priority,
    status: rule.status,
  };
}
function mapPageRule(rule: RawPageRule): CloudflarePageRule {
  return {
    id: rule.id,
    target: rule.targets?.find((item) => item.target === 'url')?.constraint?.value ?? '',
    actions: rule.actions ?? [],
    priority: rule.priority ?? 1,
    status: rule.status ?? 'disabled',
  };
}
function mapRedirectRule(rule: RawRedirectRule, priority = 1): CloudflareRedirectRule {
  return {
    id: rule.id ?? rule.ref ?? `redirect-${priority}`,
    source: rule.expression,
    destination: rule.action_parameters.from_value.target_url.value ?? '',
    status: rule.enabled === false ? 'disabled' : 'active',
    priority,
    statusCode: redirectStatus(rule.action_parameters.from_value.status_code),
    preserveQueryString: rule.action_parameters.from_value.preserve_query_string ?? true,
  };
}
function redirectRuleBody(
  rule: CloudflareRedirectRule | Omit<CloudflareRedirectRule, 'id'>,
): RawRedirectRule {
  return {
    ...('id' in rule && rule.id ? { ref: rule.id } : {}),
    expression: rule.source,
    description: `CloudForge redirect to ${rule.destination}`,
    enabled: rule.status === 'active',
    action: 'redirect',
    action_parameters: {
      from_value: {
        target_url: { value: rule.destination },
        status_code: rule.statusCode,
        preserve_query_string: rule.preserveQueryString,
      },
    },
  };
}
function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : fallback;
}
function redirectStatus(value: number | undefined): 301 | 302 | 307 | 308 {
  return value === 302 || value === 307 || value === 308 ? value : 301;
}
function safeString(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
function securityHeaderHsts(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const strict = (value as { strict_transport_security?: unknown }).strict_transport_security;
  return Boolean(
    strict && typeof strict === 'object' && (strict as { enabled?: unknown }).enabled === true,
  );
}
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
