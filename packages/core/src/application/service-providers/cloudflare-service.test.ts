import { describe, expect, it, vi } from 'vitest';
import { err, ok, ValidationError } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { RuntimeTopologySynchronizer } from '../ports/runtime-topology-synchronizer.js';
import type {
  CloudflareDnsRecord,
  CloudflareDnsRecordInput,
  CloudflareProvider,
} from './cloudflare.js';
import { CloudflareService, validateDnsRecord } from './cloudflare-service.js';

describe('validateDnsRecord', () => {
  it('normalizes valid proxied A records', () => {
    const result = validateDnsRecord({
      type: 'A',
      name: ' App.Example.com ',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
      tags: [' production ', ''],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('app.example.com');
      expect(result.value.tags).toEqual(['production']);
    }
  });

  it.each([
    ['@', 'example.com'],
    ['www', 'www.example.com'],
    ['api.dev', 'api.dev.example.com'],
    ['*.preview', '*.preview.example.com'],
    ['already.example.com.', 'already.example.com'],
  ])('normalizes the zone-relative name %s', (name, expected) => {
    const result = validateDnsRecord(
      { type: 'A', name, content: '203.0.113.10', ttl: 1, proxied: true },
      'example.com',
    );
    expect(result.ok && result.value.name).toBe(expected);
  });

  it('normalizes local CNAME targets before checking for self references', () => {
    const valid = validateDnsRecord(
      { type: 'CNAME', name: 'www', content: '@', ttl: 1, proxied: true },
      'example.com',
    );
    expect(valid.ok && valid.value.content).toBe('example.com');

    const invalid = validateDnsRecord(
      { type: 'CNAME', name: 'www', content: 'www', ttl: 1, proxied: true },
      'example.com',
    );
    expect(invalid.ok).toBe(false);
  });

  it.each([
    [{ type: 'A', name: 'example.com', content: '999.0.0.1', ttl: 1, proxied: true }, 'valid A'],
    [
      { type: 'CNAME', name: 'app.example.com', content: 'app.example.com', ttl: 1, proxied: true },
      'CNAME',
    ],
    [
      { type: 'TXT', name: 'example.com', content: 'value', ttl: 1, proxied: true },
      'cannot be proxied',
    ],
    [{ type: 'A', name: 'example.com', content: '203.0.113.10', ttl: 10, proxied: false }, 'TTL'],
    [
      { type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 300, proxied: false },
      'priority',
    ],
  ] as const)('rejects invalid input', (input, message) => {
    const result = validateDnsRecord(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });
});

describe('Cloudflare runtime synchronization', () => {
  it('publishes only CloudForge-owned DNS records into the runtime topology', async () => {
    const replaceDnsRecords = vi.fn().mockResolvedValue(ok(undefined));
    const runtime = {
      upsertApplication: vi.fn(),
      removeApplication: vi.fn(),
      replaceRoutes: vi.fn(),
      upsertRoute: vi.fn(),
      removeRoute: vi.fn(),
      replaceCertificates: vi.fn(),
      upsertCertificate: vi.fn(),
      upsertDnsRecord: vi.fn(),
      replaceDnsRecords,
      removeDnsRecord: vi.fn(),
    } as unknown as RuntimeTopologySynchronizer;
    const managed = {
      id: 'managed-record',
      zoneId: 'zone-1',
      type: 'A',
      name: 'app.example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
      proxiable: true,
      comment: 'Managed by CloudForge',
      tags: [],
      priority: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-02T00:00:00.000Z',
    } as const;
    const external = {
      ...managed,
      id: 'external-record',
      name: 'mail.example.com',
      comment: 'Created by the user',
    };
    const provider = {
      kind: 'cloudflare',
      dnsRecords: vi.fn().mockResolvedValue(ok([managed, external])),
    } as unknown as CloudflareProvider;
    const service = new CloudflareService(
      {
        getDecrypted: vi.fn().mockResolvedValue(
          ok({
            kind: 'cloudflare',
            data: { apiToken: 'not-exposed-to-runtime' },
          }),
        ),
      } as unknown as CredentialService,
      { create: vi.fn().mockReturnValue(ok(provider)) },
      { recordSafe: vi.fn() } as unknown as ActivityService,
      undefined,
      runtime,
    );

    const result = await service.dnsRecords('credential-1', 'zone-1');

    expect(result.ok).toBe(true);
    expect(replaceDnsRecords).toHaveBeenCalledWith('zone-1', [
      expect.objectContaining({
        sourceId: 'managed-record',
        zoneId: 'zone-1',
        domain: 'app.example.com',
        content: '203.0.113.10',
        ownership: 'cloudforge-managed',
      }),
    ]);
  });

  it('uses the selected zone when a Cloudflare record response omits its zone id', async () => {
    const replaceDnsRecords = vi.fn().mockResolvedValue(ok(undefined));
    const runtime = {
      replaceDnsRecords,
    } as unknown as RuntimeTopologySynchronizer;
    const provider = {
      kind: 'cloudflare',
      dnsRecords: vi.fn().mockResolvedValue(
        ok([
          {
            id: 'managed-record',
            zoneId: undefined,
            type: 'A',
            name: 'app.example.com',
            content: '203.0.113.10',
            ttl: 1,
            proxied: true,
            proxiable: true,
            comment: 'Managed by CloudForge',
            tags: [],
            priority: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            modifiedAt: '2026-01-02T00:00:00.000Z',
          } as unknown as CloudflareDnsRecord,
        ]),
      ),
    } as unknown as CloudflareProvider;
    const service = new CloudflareService(
      {
        getDecrypted: vi
          .fn()
          .mockResolvedValue(ok({ kind: 'cloudflare', data: { apiToken: 'secret' } })),
      } as unknown as CredentialService,
      { create: vi.fn().mockReturnValue(ok(provider)) },
      { recordSafe: vi.fn() } as unknown as ActivityService,
      undefined,
      runtime,
    );

    const result = await service.dnsRecords('credential-1', 'zone-1');

    expect(result.ok).toBe(true);
    expect(replaceDnsRecords).toHaveBeenCalledWith('zone-1', [
      expect.objectContaining({ zoneId: 'zone-1' }),
    ]);
  });

  it('keeps live Cloudflare records visible when legacy Runtime synchronization fails', async () => {
    const recordSafe = vi.fn();
    const runtime = {
      replaceDnsRecords: vi
        .fn()
        .mockResolvedValue(err(new ValidationError('Duplicate runtime DNS record'))),
    } as unknown as RuntimeTopologySynchronizer;
    const record = {
      id: 'record-1',
      zoneId: 'zone-1',
      type: 'A',
      name: 'app.example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
      proxiable: true,
      comment: 'Managed by CloudForge',
      tags: [],
      priority: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-02T00:00:00.000Z',
    } as const;
    const provider = {
      kind: 'cloudflare',
      dnsRecords: vi.fn().mockResolvedValue(ok([record])),
    } as unknown as CloudflareProvider;
    const service = new CloudflareService(
      {
        getDecrypted: vi
          .fn()
          .mockResolvedValue(ok({ kind: 'cloudflare', data: { apiToken: 'secret' } })),
      } as unknown as CredentialService,
      { create: vi.fn().mockReturnValue(ok(provider)) },
      { recordSafe } as unknown as ActivityService,
      undefined,
      runtime,
    );

    const result = await service.dnsRecords('credential-1', 'zone-1');

    expect(result).toEqual(ok([record]));
    expect(recordSafe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cloudflare.runtime_sync.failed' }),
    );
  });
});

describe('Cloudflare DNS batch address updates', () => {
  const rootRecord = {
    id: 'root-record',
    zoneId: 'zone-1',
    type: 'A',
    name: 'example.com',
    content: '203.0.113.10',
    ttl: 1,
    proxied: true,
    proxiable: true,
    comment: 'Managed by CloudForge',
    tags: [],
    priority: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
  } as const;
  const appRecord = {
    ...rootRecord,
    id: 'app-record',
    name: 'app.example.com',
  } as const;
  const cnameRecord = {
    ...rootRecord,
    id: 'www-record',
    type: 'CNAME',
    name: 'www.example.com',
    content: 'example.com',
  } as const;

  function createService(
    records: readonly CloudflareDnsRecord[] = [rootRecord, appRecord, cnameRecord],
  ) {
    const updateDnsRecord = vi.fn(
      (_zoneId: string, recordId: string, input: CloudflareDnsRecordInput) => {
        const existing = records.find((record) => record.id === recordId);
        if (!existing) throw new Error(`Unknown test DNS record ${recordId}`);
        return Promise.resolve(ok({ ...existing, ...input, id: recordId, zoneId: 'zone-1' }));
      },
    );
    const provider = {
      kind: 'cloudflare',
      zones: vi.fn().mockResolvedValue(
        ok([
          {
            id: 'zone-1',
            name: 'example.com',
            status: 'active',
            plan: 'free',
            developmentMode: 0,
            nameServers: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            accountId: 'account-1',
            accountName: 'Account',
          },
        ]),
      ),
      dnsRecords: vi.fn().mockResolvedValue(ok(records)),
      updateDnsRecord,
    } as unknown as CloudflareProvider;
    const service = new CloudflareService(
      {
        getDecrypted: vi
          .fn()
          .mockResolvedValue(
            ok({ kind: 'cloudflare', data: { apiToken: 'not-exposed-to-renderer' } }),
          ),
      } as unknown as CredentialService,
      { create: vi.fn().mockReturnValue(ok(provider)) },
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );
    return { service, updateDnsRecord };
  }

  it('repoints every selected A record while leaving an unselected CNAME unchanged', async () => {
    const { service, updateDnsRecord } = createService();

    const result = await service.batchDnsRecords('credential-1', 'zone-1', {
      kind: 'address',
      recordIds: ['root-record', 'app-record'],
      address: '198.51.100.20',
    });

    expect(result).toEqual(ok({ changed: 2 }));
    expect(updateDnsRecord).toHaveBeenCalledTimes(2);
    expect(updateDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      'root-record',
      expect.objectContaining({ type: 'A', content: '198.51.100.20' }),
    );
    expect(updateDnsRecord).toHaveBeenCalledWith(
      'zone-1',
      'app-record',
      expect.objectContaining({ type: 'A', content: '198.51.100.20' }),
    );
    expect(updateDnsRecord).not.toHaveBeenCalledWith('zone-1', 'www-record', expect.anything());
  });

  it('rejects non-address records before changing anything', async () => {
    const { service, updateDnsRecord } = createService();

    const result = await service.batchDnsRecords('credential-1', 'zone-1', {
      kind: 'address',
      recordIds: ['root-record', 'www-record'],
      address: '198.51.100.20',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Only A and AAAA');
    expect(updateDnsRecord).not.toHaveBeenCalled();
  });

  it('rejects an invalid address before changing anything', async () => {
    const { service, updateDnsRecord } = createService();

    const result = await service.batchDnsRecords('credential-1', 'zone-1', {
      kind: 'address',
      recordIds: ['root-record', 'app-record'],
      address: 'not-an-ip-address',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('valid A address');
    expect(updateDnsRecord).not.toHaveBeenCalled();
  });
});
