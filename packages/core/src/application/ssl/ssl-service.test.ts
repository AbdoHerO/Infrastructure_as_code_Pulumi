import { describe, expect, it, vi } from 'vitest';
import { DeploymentError, err, ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { CertificateManager } from '../ports/certificate-manager.js';
import { SslService } from './ssl-service.js';

const config = {
  domain: 'app.example.com',
  email: 'owner@example.com',
  certificateVolume: '/opt/certs',
  webrootVolume: '/opt/www',
  forceRenewal: false,
};
const target = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:test',
};

describe('SslService', () => {
  it('blocks issuance when DNS does not point to the selected VPS', async () => {
    const issue = vi.fn();
    const service = new SslService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      { resolve: vi.fn().mockResolvedValue(ok(['198.51.100.20'])) },
      { issue } as unknown as CertificateManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
    );
    const result = await service.issue('target', config);
    expect(result.ok).toBe(false);
    expect(issue.mock.calls).toHaveLength(0);
  });

  it('issues only after a matching DNS verification', async () => {
    const certificate = {
      domain: config.domain,
      issuer: 'Test CA',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      daysRemaining: 1,
      sans: [config.domain],
      wildcard: false,
      keyAlgorithm: 'RSA',
      fingerprint: 'abc',
    };
    const issue = vi.fn().mockResolvedValue(ok(certificate));
    const recordSafe = vi.fn();
    const upsertCertificate = vi.fn().mockResolvedValue(ok(undefined));
    const service = new SslService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      { resolve: vi.fn().mockResolvedValue(ok(['203.0.113.10'])) },
      { issue } as unknown as CertificateManager,
      { recordSafe } as unknown as ActivityService,
      undefined,
      undefined,
      undefined,
      undefined,
      { upsertCertificate } as never,
    );
    const result = await service.issue('target', config);
    expect(result).toEqual(ok(certificate));
    expect(issue.mock.calls).toHaveLength(1);
    expect(recordSafe.mock.calls).toHaveLength(1);
    expect(upsertCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'target',
        domain: 'app.example.com',
        authority: 'letsencrypt',
        status: 'expiring',
        ownership: 'cloudforge-managed',
      }),
    );
  });

  it('verifies a proxied Cloudflare record against its origin instead of edge IPs', async () => {
    const service = new SslService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      { resolve: vi.fn().mockResolvedValue(ok(['104.16.1.10', '104.16.2.10'])) },
      {} as CertificateManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
      undefined,
      undefined,
      {
        verify: vi.fn().mockResolvedValue(
          ok({
            status: 'propagated',
            warning: null,
            current: target.host,
            proxied: true,
            publicAnswers: ['104.16.1.10', '104.16.2.10'],
            sslMode: 'strict',
            certificateRequirement: 'required',
          }),
        ),
      } as never,
    );
    const result = await service.verifyDns('target', config.domain);
    expect(result.ok && result.value.matches).toBe(true);
    expect(result.ok && result.value.provider).toBe('cloudflare');
    expect(result.ok && result.value.sslMode).toBe('strict');
  });

  it('uses managed Cloudflare verification before public DNS is available', async () => {
    const publicDns = vi
      .fn()
      .mockResolvedValue(err(new DeploymentError('DNS has no A or AAAA record')));
    const service = new SslService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      { resolve: publicDns },
      {} as CertificateManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
      undefined,
      undefined,
      {
        verify: vi.fn().mockResolvedValue(
          ok({
            status: 'propagated',
            warning: null,
            current: target.host,
            proxied: true,
            publicAnswers: ['104.16.1.10'],
            sslMode: 'strict',
            certificateRequirement: 'required',
          }),
        ),
      } as never,
    );

    const result = await service.verifyDns('target', config.domain);

    expect(result.ok && result.value.matches).toBe(true);
    expect(result.ok && result.value.provider).toBe('cloudflare');
    expect(publicDns).not.toHaveBeenCalled();
  });

  it('creates and installs a Cloudflare Origin CA certificate through the application ports', async () => {
    const certificate = {
      domain: config.domain,
      issuer: 'Cloudflare Origin SSL Certificate Authority',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      daysRemaining: 1,
      sans: [config.domain, `*.${config.domain}`],
      wildcard: true,
      keyAlgorithm: 'ECDSA',
      fingerprint: 'abc',
    };
    const prepareOriginCertificate = vi
      .fn()
      .mockResolvedValue(ok({ csr: 'csr', workspace: '/tmp/cloudforge-origin-test' }));
    const installOriginCertificate = vi.fn().mockResolvedValue(ok(certificate));
    const createOriginCertificate = vi.fn().mockResolvedValue(
      ok({
        id: 'origin-1',
        certificate: 'certificate',
        hostnames: certificate.sans,
        expiresAt: certificate.expiresAt,
        requestType: 'origin-ecc',
      }),
    );
    const enableStrictSslForDomain = vi.fn().mockResolvedValue(ok({}));
    const saveSite = vi.fn().mockResolvedValue(ok({ summary: 'saved' }));
    const service = new SslService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      { resolve: vi.fn().mockResolvedValue(ok(['104.16.1.10'])) },
      {
        prepareOriginCertificate,
        installOriginCertificate,
      } as unknown as CertificateManager,
      { recordSafe: vi.fn() } as unknown as ActivityService,
      undefined,
      {
        listSites: vi.fn().mockResolvedValue(
          ok([
            {
              domain: config.domain,
              managed: true,
              ssl: false,
              upstreamHost: '127.0.0.1',
              upstreamPort: 8000,
            },
          ]),
        ),
        saveSite,
      } as never,
      {
        verify: vi.fn().mockResolvedValue(
          ok({
            status: 'propagated',
            warning: null,
            current: target.host,
            proxied: true,
            publicAnswers: ['104.16.1.10'],
            sslMode: 'full',
            certificateRequirement: 'recommended',
          }),
        ),
      } as never,
      { createOriginCertificate, enableStrictSslForDomain } as never,
    );

    const result = await service.issue('target', {
      ...config,
      authority: 'cloudflare-origin-ca',
      cloudflareCredentialId: 'cloudflare-1',
      includeWildcard: true,
      keyAlgorithm: 'ecc',
      validityDays: 5475,
    });

    expect(result).toEqual(ok(certificate));
    expect(prepareOriginCertificate).toHaveBeenCalledWith(
      target,
      expect.anything(),
      [config.domain, `*.${config.domain}`],
      undefined,
    );
    expect(createOriginCertificate).toHaveBeenCalledWith(
      'cloudflare-1',
      expect.objectContaining({ requestType: 'origin-ecc', validityDays: 5475 }),
    );
    expect(saveSite).toHaveBeenCalled();
    expect(enableStrictSslForDomain).toHaveBeenCalledWith('cloudflare-1', config.domain);
  });
});
