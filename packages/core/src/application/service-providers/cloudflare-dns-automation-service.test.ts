import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DomainResolver } from '../ports/certificate-manager.js';
import type { SettingsService } from '../settings/settings-service.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import type { CloudflareService } from './cloudflare-service.js';
import { CloudflareDnsAutomationService } from './cloudflare-dns-automation-service.js';

const zone = {
  id: 'zone-1',
  name: 'example.com',
  status: 'active',
  plan: 'Free',
  developmentMode: 0,
  nameServers: ['one.ns.cloudflare.com', 'two.ns.cloudflare.com'],
  createdAt: new Date().toISOString(),
  accountId: 'account-1',
  accountName: 'Example',
};

const record = {
  id: 'record-1',
  zoneId: zone.id,
  type: 'A' as const,
  name: 'app.example.com',
  content: '203.0.113.10',
  ttl: 1,
  proxied: true,
  proxiable: true,
  comment: '',
  tags: [],
  priority: null,
  createdAt: new Date().toISOString(),
  modifiedAt: new Date().toISOString(),
};

function service(proxied: boolean): CloudflareDnsAutomationService {
  const cloudflare = {
    zones: vi.fn().mockResolvedValue(ok([zone])),
    dnsRecords: vi.fn().mockResolvedValue(ok([{ ...record, proxied }])),
    zoneSettings: vi.fn().mockResolvedValue(ok({ sslMode: 'full' })),
  } as unknown as CloudflareService;
  const settings = {
    get: vi.fn().mockResolvedValue(
      ok({
        ...DEFAULT_SETTINGS,
        cloudflare: {
          ...DEFAULT_SETTINGS.cloudflare,
          defaultCredentialId: 'credential-1',
          defaultZoneId: zone.id,
        },
      }),
    ),
  } as unknown as SettingsService;
  const dns = {
    resolve: vi.fn().mockResolvedValue(ok([])),
  } as DomainResolver;
  return new CloudflareDnsAutomationService(cloudflare, settings, dns, {
    recordSafe: vi.fn(),
  } as unknown as ActivityService);
}

describe('CloudflareDnsAutomationService', () => {
  it('does not attach plan-restricted tags to automatic DNS records', async () => {
    const updateDnsRecord = vi.fn().mockResolvedValue(ok(record));
    const cloudflare = {
      zones: vi.fn().mockResolvedValue(ok([zone])),
      dnsRecords: vi.fn().mockResolvedValue(ok([record])),
      updateDnsRecord,
      zoneSettings: vi.fn().mockResolvedValue(ok({ sslMode: 'full' })),
    } as unknown as CloudflareService;
    const settings = {
      get: vi.fn().mockResolvedValue(
        ok({
          ...DEFAULT_SETTINGS,
          cloudflare: {
            ...DEFAULT_SETTINGS.cloudflare,
            defaultCredentialId: 'credential-1',
            defaultZoneId: zone.id,
            waitForPropagation: false,
          },
        }),
      ),
    } as unknown as SettingsService;
    const automation = new CloudflareDnsAutomationService(
      cloudflare,
      settings,
      { resolve: vi.fn().mockResolvedValue(ok([])) },
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );

    const result = await automation.ensure(record.name, record.content);

    expect(result.ok).toBe(true);
    expect(updateDnsRecord).toHaveBeenCalledWith(
      'credential-1',
      zone.id,
      record.id,
      expect.objectContaining({ comment: 'Managed by CloudForge', tags: [] }),
    );
  });

  it('accepts an active proxied record whose origin matches the VPS', async () => {
    const result = await service(true).verify('app.example.com', record.content);

    expect(result.ok && result.value.status).toBe('propagated');
    expect(result.ok && result.value.current).toBe(record.content);
    expect(result.ok && result.value.warning).toContain('active zone');
  });

  it('still requires a public origin match for DNS-only records', async () => {
    const result = await service(false).verify('app.example.com', record.content);

    expect(result.ok && result.value.status).toBe('pending');
  });
});
