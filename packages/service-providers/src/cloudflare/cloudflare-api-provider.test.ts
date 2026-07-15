import { describe, expect, it } from 'vitest';
import { err, ok, ServiceProviderError, type Result } from '@cloudforge/shared';
import { CloudflareApiProvider, type CloudflareApiTransport } from './cloudflare-api-provider.js';

class FakeTransport implements CloudflareApiTransport {
  readonly calls: { path: string; init?: RequestInit }[] = [];
  constructor(private readonly values: Record<string, unknown>) {}
  request<T>(path: string, init?: RequestInit): Promise<Result<T, ServiceProviderError>> {
    this.calls.push({ path, ...(init ? { init } : {}) });
    const value = this.values[path];
    if (value && typeof value === 'object' && 'ok' in value)
      return Promise.resolve(value as Result<T, ServiceProviderError>);
    return Promise.resolve(ok(value as T));
  }
  graphql<T>(): Promise<Result<T, ServiceProviderError>> {
    return Promise.resolve(ok(this.values['/graphql'] as T));
  }
}

describe('CloudflareApiProvider', () => {
  it('tests the real account and zone capabilities without assuming a user-owned token', async () => {
    const api = new FakeTransport({
      '/accounts?per_page=50': [{ id: 'account-1', name: 'Acme' }],
      '/user': { email: 'owner@example.com' },
      '/zones?per_page=50': [
        {
          id: 'zone-1',
          name: 'example.com',
          status: 'active',
          account: { id: 'account-1', name: 'Acme' },
          plan: { name: 'Free' },
        },
      ],
    });

    const result = await CloudflareApiProvider.fromTransport(api).testConnection();

    expect(result.ok && result.value.connected).toBe(true);
    expect(result.ok && result.value.zones?.[0]?.name).toBe('example.com');
    expect(api.calls.map(({ path }) => path)).not.toContain('/user/tokens/verify');
  });

  it('maps zones and DNS records without exposing the token', async () => {
    const api = new FakeTransport({
      '/zones?per_page=50': [
        {
          id: 'zone-1',
          name: 'example.com',
          status: 'active',
          plan: { name: 'Free' },
          account: { id: 'account-1', name: 'Acme' },
        },
      ],
      '/zones/zone-1/dns_records?per_page=500': [
        {
          id: 'record-1',
          zone_id: 'zone-1',
          type: 'A',
          name: 'app.example.com',
          content: '203.0.113.10',
          ttl: 1,
          proxied: true,
        },
      ],
    });
    const provider = CloudflareApiProvider.fromTransport(api);
    const zones = await provider.zones();
    const records = await provider.dnsRecords('zone-1');
    expect(zones.ok && zones.value[0]?.plan).toBe('Free');
    expect(records.ok && records.value[0]?.content).toBe('203.0.113.10');
    expect(JSON.stringify(api.calls)).not.toContain('token');
  });

  it('reports inaccessible dashboard capabilities instead of displaying false zero values', async () => {
    const denied = err(new ServiceProviderError('Cloudflare API 403: Authentication error'));
    const api = new FakeTransport({
      '/accounts?per_page=50': [{ id: 'account-1', name: 'Acme' }],
      '/user': {},
      '/zones?per_page=50': [
        {
          id: 'zone-1',
          name: 'example.com',
          status: 'active',
          account: { id: 'account-1', name: 'Acme' },
          plan: { name: 'Free' },
        },
      ],
      '/zones/zone-1/dns_records?per_page=500': denied,
      '/zones/zone-1/settings': denied,
      '/zones/zone-1/pagerules?order=priority': denied,
    });

    const result = await CloudflareApiProvider.fromTransport(api).dashboard('zone-1');

    expect(result.ok && result.value.apiStatus).toBe('limited permissions');
    expect(result.ok && result.value.dnsRecords).toBeNull();
    expect(result.ok && result.value.warnings).toHaveLength(4);
  });

  it('uses an in-place PUT when editing a DNS record', async () => {
    const path = '/zones/zone-1/dns_records/record-1';
    const api = new FakeTransport({
      [path]: {
        id: 'record-1',
        zone_id: 'zone-1',
        type: 'A',
        name: 'app.example.com',
        content: '203.0.113.20',
        ttl: 300,
      },
    });
    const provider = CloudflareApiProvider.fromTransport(api);
    const result = await provider.updateDnsRecord('zone-1', 'record-1', {
      type: 'A',
      name: 'app.example.com',
      content: '203.0.113.20',
      ttl: 300,
      proxied: false,
    });
    expect(result.ok).toBe(true);
    expect(api.calls[0]?.init?.method).toBe('PUT');
  });

  it('maps the Cloudflare Page Rule target shape', async () => {
    const path = '/zones/zone-1/pagerules?order=priority';
    const api = new FakeTransport({
      [path]: [
        {
          id: 'rule-1',
          targets: [{ target: 'url', constraint: { value: 'example.com/*' } }],
          actions: [{ id: 'always_use_https', value: 'on' }],
          priority: 1,
          status: 'active',
        },
      ],
    });
    const rules = await CloudflareApiProvider.fromTransport(api).pageRules('zone-1');
    expect(rules.ok && rules.value[0]?.target).toBe('example.com/*');
  });

  it('maps and updates Redirect Rules through the zone ruleset entrypoint', async () => {
    const entrypoint = '/zones/zone-1/rulesets/phases/http_request_dynamic_redirect/entrypoint';
    const ruleset = '/zones/zone-1/rulesets/ruleset-1';
    const raw = {
      id: 'ruleset-1',
      name: 'CloudForge Redirect Rules',
      kind: 'zone',
      phase: 'http_request_dynamic_redirect',
      rules: [
        {
          id: 'redirect-1',
          expression: '(http.host eq "example.com")',
          enabled: true,
          action: 'redirect',
          action_parameters: {
            from_value: {
              target_url: { value: 'https://www.example.com' },
              status_code: 301,
              preserve_query_string: true,
            },
          },
        },
      ],
    };
    const api = new FakeTransport({ [entrypoint]: raw, [ruleset]: raw });
    const provider = CloudflareApiProvider.fromTransport(api);
    const listed = await provider.redirectRules('zone-1');
    const saved = await provider.saveRedirectRule('zone-1', {
      id: 'redirect-1',
      source: '(http.host eq "example.com")',
      destination: 'https://www.example.com',
      status: 'active',
      priority: 1,
      statusCode: 301,
      preserveQueryString: true,
    });
    expect(listed.ok && listed.value[0]?.destination).toBe('https://www.example.com');
    expect(saved.ok).toBe(true);
    expect(api.calls.at(-1)?.path).toBe(ruleset);
    expect(api.calls.at(-1)?.init?.method).toBe('PUT');
  });

  it('maps GraphQL analytics into dashboard metrics', async () => {
    const api = new FakeTransport({
      '/graphql': {
        viewer: {
          zones: [
            {
              daily: [
                {
                  dimensions: { date: '2026-07-15' },
                  sum: { requests: 100, bytes: 2048, cachedRequests: 80, threats: 2 },
                  uniq: { uniques: 25 },
                },
              ],
              countries: [{ count: 50, dimensions: { clientCountryName: 'MA' } }],
              urls: [{ count: 40, dimensions: { clientRequestPath: '/' } }],
              statuses: [{ count: 95, dimensions: { edgeResponseStatus: 200 } }],
            },
          ],
        },
      },
    });
    const result = await CloudflareApiProvider.fromTransport(api).analytics(
      'zone-1',
      '2026-07-15T00:00:00.000Z',
      '2026-07-15T23:59:59.000Z',
    );
    expect(result.ok && result.value.requests).toBe(100);
    expect(result.ok && result.value.countries[0]?.name).toBe('MA');
  });
});
