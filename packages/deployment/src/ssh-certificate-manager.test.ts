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
    expect(command).toContain('cloudforge_open 80 tcp');
    expect(command).toContain('cloudforge_open 443 tcp');
    expect(command).toContain('netfilter-persistent save');
    expect(command).toContain('certbot/certbot certonly');
    // The firewall step is best-effort and must not abort an issuance that would
    // otherwise have worked: this whole script runs under `set -e`.
    expect(command).toContain('|| true');
  });

  it('opens the firewall before Certbot runs, not after', async () => {
    // An ACME HTTP-01 challenge arrives on port 80 while certbot waits. Opening
    // it afterwards is opening it too late.
    runPrivilegedRemote
      .mockResolvedValueOnce(ok({ stdout: '', stderr: '' }))
      .mockResolvedValueOnce(ok({ stdout: 'sha256 Fingerprint=AA:BB', stderr: '' }));
    const { SshCertificateManager } = await import('./ssh-certificate-manager.js');

    await new SshCertificateManager().issue(target, config);

    const command = String(runPrivilegedRemote.mock.calls[0]?.[1]);
    expect(command.indexOf('cloudforge_open 80 tcp')).toBeLessThan(
      command.indexOf('certbot/certbot certonly'),
    );
  });

  it('opens HTTPS on the host firewall when it installs an Origin CA certificate', async () => {
    // Cloudflare connects to an Origin CA site on 443. A site switched to HTTPS
    // behind a closed 443 answers 523 to every visitor.
    runPrivilegedRemote
      .mockResolvedValueOnce(ok({ stdout: '', stderr: '' }))
      .mockResolvedValueOnce(ok({ stdout: 'sha256 Fingerprint=AA:BB', stderr: '' }));
    const { SshCertificateManager } = await import('./ssh-certificate-manager.js');

    await new SshCertificateManager().installOriginCertificate(
      target,
      { ...config, authority: 'cloudflare-origin-ca' },
      '/tmp/cloudforge-origin-0123456789abcdef',
      '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----\n',
    );

    const command = String(runPrivilegedRemote.mock.calls[0]?.[1]);
    expect(command).toContain('cloudforge_open 443 tcp');
    expect(command).toContain('netfilter-persistent save');
    // Best effort and ahead of `set -eu`, so a firewall it cannot drive
    // neither aborts the install nor trips over an unset variable.
    expect(command).toContain('|| true');
    expect(command.indexOf('cloudforge_open 443 tcp')).toBeLessThan(command.indexOf('set -eu'));
    expect(command.indexOf('cloudforge_open 443 tcp')).toBeLessThan(
      command.indexOf('"$live/cert.pem"'),
    );
    // HTTP is not needed by Cloudflare's proxy, so it is not opened on its behalf.
    expect(command).not.toContain('cloudforge_open 80 tcp');
  });

  it('generates an Origin CA private key on the VPS and returns only its CSR', async () => {
    runPrivilegedRemote.mockResolvedValueOnce(
      ok({
        stdout: Buffer.from('-----BEGIN CERTIFICATE REQUEST-----\ncsr\n').toString('base64'),
        stderr: '',
      }),
    );
    const { SshCertificateManager } = await import('./ssh-certificate-manager.js');

    const result = await new SshCertificateManager().prepareOriginCertificate(
      target,
      { ...config, authority: 'cloudflare-origin-ca', keyAlgorithm: 'ecc' },
      ['example.com', '*.example.com'],
    );

    expect(result.ok && result.value.csr).toContain('BEGIN CERTIFICATE REQUEST');
    const command = String(runPrivilegedRemote.mock.calls[0]?.[1]);
    expect(command).toContain('openssl ecparam');
    expect(command).toContain('subjectAltName=DNS:example.com,DNS:*.example.com');
    expect(command).not.toContain('BEGIN PRIVATE KEY');
  });
});
