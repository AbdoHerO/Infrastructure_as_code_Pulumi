import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DomainResolver } from '../ports/certificate-manager.js';
import type { SettingsService } from '../settings/settings-service.js';
import { DEFAULT_SETTINGS } from '../settings/settings.js';
import type { CloudflareDnsRecord } from './cloudflare.js';
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

/** A record CloudForge created, and may therefore change. */
const managedRecord = { ...record, comment: 'Managed by CloudForge' };

describe('CloudflareDnsAutomationService', () => {
  it('does not attach plan-restricted tags to automatic DNS records', async () => {
    const updateDnsRecord = vi.fn().mockResolvedValue(ok(managedRecord));
    const cloudflare = {
      zones: vi.fn().mockResolvedValue(ok([zone])),
      dnsRecords: vi.fn().mockResolvedValue(ok([managedRecord])),
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

  describe('records CloudForge did not create', () => {
    const build = (existing: CloudflareDnsRecord) => {
      const createDnsRecord = vi.fn().mockResolvedValue(ok(existing));
      const updateDnsRecord = vi.fn().mockResolvedValue(ok(existing));
      const recordSafe = vi.fn();
      const cloudflare = {
        zones: vi.fn().mockResolvedValue(ok([zone])),
        dnsRecords: vi.fn().mockResolvedValue(ok([existing])),
        createDnsRecord,
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
        { recordSafe } as unknown as ActivityService,
      );
      return { automation, createDnsRecord, updateDnsRecord, recordSafe };
    };

    it('refuses to repoint a record it did not create', async () => {
      // The bug this replaces: configuring a pipeline for a domain that already
      // served real traffic silently moved that traffic to the VPS and stamped
      // CloudForge's marker on the record on the way past. DNS has no undo — by
      // the time anyone noticed, resolvers worldwide had cached the new answer.
      const ctx = build({ ...record, content: '198.51.100.7', comment: '' });

      const result = await ctx.automation.ensure('app.example.com', '203.0.113.10');

      expect(result.ok).toBe(false);
      expect(ctx.updateDnsRecord).not.toHaveBeenCalled();
      expect(ctx.createDnsRecord).not.toHaveBeenCalled();
    });

    it('says what is there and what to do about it', async () => {
      // A refusal a user cannot act on is just a wall.
      const ctx = build({ ...record, content: '198.51.100.7', comment: '' });

      const result = await ctx.automation.ensure('app.example.com', '203.0.113.10');

      if (!result.ok) {
        expect(result.error.message).toContain('198.51.100.7');
        expect(result.error.message).toContain('203.0.113.10');
        expect(result.error.message).toContain('CloudForge did not create it');
      }
    });

    it('refuses to replace a CNAME it did not create', async () => {
      const ctx = build({
        ...record,
        type: 'CNAME' as const,
        content: 'somewhere-else.example.com',
        comment: '',
      });

      expect((await ctx.automation.ensure('app.example.com', '203.0.113.10')).ok).toBe(false);
    });

    it('leaves a record that already points here entirely alone', async () => {
      // Nothing to change, and nothing to claim: stamping the marker on someone
      // else's record would let a later CloudForge action withdraw a record it
      // never created.
      const ctx = build({ ...record, content: '203.0.113.10', comment: '' });

      const result = await ctx.automation.ensure('app.example.com', '203.0.113.10');

      expect(result.ok).toBe(true);
      expect(ctx.updateDnsRecord).not.toHaveBeenCalled();
      expect(ctx.recordSafe.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'cloudflare.dns.unmanaged',
      });
    });

    it('does not treat a CNAME as already pointing here', async () => {
      // A CNAME that resolves to the right host today can be repointed by
      // whoever owns the target, so it is not the same fact as an A record.
      const ctx = build({
        ...record,
        type: 'CNAME' as const,
        content: '203.0.113.10',
        comment: '',
      });

      expect((await ctx.automation.ensure('app.example.com', '203.0.113.10')).ok).toBe(false);
    });

    it('still creates a record where none exists', async () => {
      const createDnsRecord = vi.fn().mockResolvedValue(ok(managedRecord));
      const cloudflare = {
        zones: vi.fn().mockResolvedValue(ok([zone])),
        dnsRecords: vi.fn().mockResolvedValue(ok([])),
        createDnsRecord,
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

      const result = await automation.ensure('app.example.com', '203.0.113.10');

      expect(result.ok).toBe(true);
      expect(createDnsRecord).toHaveBeenCalled();
    });

    it('still repoints a record it created itself', async () => {
      const ctx = build({ ...managedRecord, content: '198.51.100.7' });

      const result = await ctx.automation.ensure('app.example.com', '203.0.113.10');

      expect(result.ok).toBe(true);
      expect(ctx.updateDnsRecord).toHaveBeenCalled();
    });
  });

  it('updates a conflicting CNAME in place when an application needs an A record', async () => {
    // Managed, because that is the case this idempotency exists for: a CNAME
    // CloudForge itself wrote on an earlier save. One the user wrote is refused.
    const cname = {
      ...managedRecord,
      type: 'CNAME' as const,
      content: 'example.com',
    };
    const createDnsRecord = vi.fn();
    const updateDnsRecord = vi
      .fn()
      .mockResolvedValue(ok({ ...record, comment: 'Managed by CloudForge' }));
    const cloudflare = {
      zones: vi.fn().mockResolvedValue(ok([zone])),
      dnsRecords: vi.fn().mockResolvedValue(ok([cname])),
      createDnsRecord,
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
    expect(createDnsRecord).not.toHaveBeenCalled();
    expect(updateDnsRecord).toHaveBeenCalledWith(
      'credential-1',
      zone.id,
      cname.id,
      expect.objectContaining({
        type: 'A',
        name: record.name,
        content: record.content,
      }),
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
