import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
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
    const service = new SslService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      { resolve: vi.fn().mockResolvedValue(ok(['203.0.113.10'])) },
      { issue } as unknown as CertificateManager,
      { recordSafe } as unknown as ActivityService,
    );
    const result = await service.issue('target', config);
    expect(result).toEqual(ok(certificate));
    expect(issue.mock.calls).toHaveLength(1);
    expect(recordSafe.mock.calls).toHaveLength(1);
  });
});
