import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { CertificateIssueConfig, DeploymentTarget } from '@cloudforge/core';

const runPrivilegedRemote = vi.fn();
vi.mock('./ssh-nginx-manager.js', () => ({ runPrivilegedRemote }));

const target = {} as DeploymentTarget;
const config: CertificateIssueConfig = {
  domain: 'app.example.com',
  email: 'admin@example.com',
  certificateVolume: '/opt/cloudforge/certs',
  webrootVolume: '/opt/cloudforge/www',
  forceRenewal: false,
};

describe('SshCertificateManager', () => {
  beforeEach(() => {
    runPrivilegedRemote.mockReset();
  });

  it('opens and persists HTTP and HTTPS host-firewall access before Certbot', async () => {
    runPrivilegedRemote.mockResolvedValueOnce(ok({ stdout: '', stderr: '' })).mockResolvedValueOnce(
      ok({
        stdout:
          'issuer=Test CA\nnotBefore=Jul 15 00:00:00 2026 GMT\nnotAfter=Oct 15 00:00:00 2026 GMT\nsha256 Fingerprint=AA:BB\nDNS:app.example.com',
        stderr: '',
      }),
    );
    const { SshCertificateManager } = await import('./ssh-certificate-manager.js');

    const result = await new SshCertificateManager().issue(target, config);

    expect(result.ok).toBe(true);
    const command = String(runPrivilegedRemote.mock.calls[0]?.[1]);
    expect(command).toContain('cloudforge_open_tcp_port 80');
    expect(command).toContain('cloudforge_open_tcp_port 443');
    expect(command).toContain('netfilter-persistent save');
    expect(command).toContain('certbot/certbot certonly');
  });
});
