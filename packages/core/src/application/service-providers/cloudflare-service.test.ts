import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { RuntimeTopologySynchronizer } from '../ports/runtime-topology-synchronizer.js';
import type { CloudflareProvider } from './cloudflare.js';
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
        domain: 'app.example.com',
        content: '203.0.113.10',
        ownership: 'cloudforge-managed',
      }),
    ]);
  });
});
