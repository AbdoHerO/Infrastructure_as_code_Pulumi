import { describe, expect, it, vi } from 'vitest';
import { DeploymentError, err, ok } from '@cloudforge/shared';
import type { DeploymentTarget } from '../ports/deployer.js';
import { DomainPublisher, type PublishedDomain } from './domain-publisher.js';

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:test',
};

function setup(
  options: {
    sites?: unknown[];
    records?: unknown[];
    owners?: string[];
    dns?: Record<string, unknown>;
    host?: string;
  } = {},
) {
  const sites = options.sites ?? [];
  const nginx = {
    listSites: vi.fn().mockResolvedValue(ok(sites)),
    saveSite: vi.fn().mockResolvedValue(ok({ summary: 'saved' })),
    removeSite: vi.fn().mockResolvedValue(ok({ summary: 'removed' })),
  };
  const managedDns = {
    ensure: vi.fn().mockResolvedValue(
      ok({
        status: 'propagated',
        warning: null,
        proxied: false,
        sslMode: 'full',
        ...options.dns,
      }),
    ),
    withdraw: vi.fn().mockResolvedValue(ok({ removed: true })),
  };
  const certificates = {
    issue: vi.fn().mockResolvedValue(ok({ domain: 'app.example.com' })),
    forget: vi.fn().mockResolvedValue(undefined),
  };
  const cloudflare = { dnsRecords: vi.fn().mockResolvedValue(ok(options.records ?? [])) };
  const owners = { owners: vi.fn().mockResolvedValue(ok(options.owners ?? [])) };
  const resolver = { resolve: vi.fn().mockResolvedValue(ok(['198.51.100.20'])) };
  const publisher = new DomainPublisher(
    {
      resolve: vi
        .fn()
        .mockResolvedValue(ok({ ...target, ...(options.host ? { host: options.host } : {}) })),
    },
    nginx,
    managedDns,
    certificates,
    cloudflare,
    owners,
    resolver,
  );
  return { publisher, nginx, managedDns, certificates, cloudflare, owners };
}

function record(name: string, type: string, content: string) {
  return { id: `${name}-${type}`, zoneId: 'zone-1', name, type, content };
}

const route: PublishedDomain = {
  targetId: 'target-1',
  domain: 'app.example.com',
  hostPort: 8400,
  cloudflareCredentialId: 'cloudflare-1',
  cloudflareZoneId: 'zone-1',
  https: true,
  certificateEmail: 'ops@example.com',
  clientMaxBodySize: '100m',
  proxyTimeoutSeconds: 300,
  websocket: true,
};

describe('DomainPublisher.check', () => {
  const query = {
    targetId: 'target-1',
    domain: 'App.Example.com.',
    cloudflareCredentialId: 'cloudflare-1',
    cloudflareZoneId: 'zone-1',
  };

  it('says a brand-new subdomain is free and that CloudForge will create its record', async () => {
    const checked = await setup().publisher.check(query);
    expect(checked.ok && checked.value).toMatchObject({
      domain: 'app.example.com',
      available: true,
      conflicts: [],
    });
    expect(checked.ok && checked.value.notes[0]).toContain('will create it');
  });

  it('accepts a record that already points to this server', async () => {
    const checked = await setup({
      records: [record('app.example.com', 'A', '203.0.113.10')],
    }).publisher.check(query);
    expect(checked.ok && checked.value.available).toBe(true);
    expect(checked.ok && checked.value.notes[0]).toContain('already points');
  });

  it.each([
    ['an A record to another server', record('app.example.com', 'A', '198.51.100.7'), 'another'],
    ['a CNAME', record('app.example.com', 'CNAME', 'shops.example.net'), 'CNAME'],
  ])('blocks %s', async (_name, dns, reason) => {
    const checked = await setup({ records: [dns] }).publisher.check(query);
    expect(checked.ok && checked.value.available).toBe(false);
    expect(checked.ok && checked.value.conflicts.join(' ')).toContain(reason);
  });

  it('ignores other names and record types that do not carry traffic', async () => {
    const checked = await setup({
      records: [
        record('example.com', 'A', '198.51.100.7'),
        record('app.example.com', 'TXT', 'v=spf1'),
        record('app.example.com', 'MX', 'mail.example.com'),
      ],
    }).publisher.check(query);
    expect(checked.ok && checked.value.available).toBe(true);
  });

  it('blocks a domain another application or an Nginx site already uses', async () => {
    const owned = await setup({ owners: ['Docker stack rustfs'] }).publisher.check(query);
    expect(owned.ok && owned.value.conflicts[0]).toContain('Docker stack rustfs');

    const nginx = await setup({
      sites: [{ domain: 'app.example.com', managed: true, upstreamPort: 8010 }],
    }).publisher.check(query);
    expect(nginx.ok && nginx.value.available).toBe(false);

    const foreign = await setup({
      sites: [{ domain: 'app.example.com', managed: false }],
    }).publisher.check(query);
    expect(foreign.ok && foreign.value.conflicts[0]).toContain('outside CloudForge');
  });

  it('counts a domain it could not check as taken', async () => {
    const context = setup();
    context.cloudflare.dnsRecords.mockResolvedValueOnce(err(new DeploymentError('API down')));
    const dnsFailed = await context.publisher.check(query);
    expect(dnsFailed.ok && dnsFailed.value.available).toBe(false);

    const nginxDown = setup();
    nginxDown.nginx.listSites.mockResolvedValueOnce(err(new DeploymentError('SSH failed')));
    const nginxFailed = await nginxDown.publisher.check(query);
    expect(nginxFailed.ok && nginxFailed.value.available).toBe(false);
  });

  it('compares records with the resolved address when the server is saved by name', async () => {
    const checked = await setup({
      host: 'vps.example.net',
      records: [record('app.example.com', 'A', '198.51.100.20')],
    }).publisher.check(query);
    expect(checked.ok && checked.value.available).toBe(true);
  });

  it('refuses something that is not a domain name', async () => {
    expect((await setup().publisher.check({ ...query, domain: 'not a domain' })).ok).toBe(false);
  });
});

describe('DomainPublisher.publish', () => {
  it('creates the DNS record, then the Nginx site, then the certificate', async () => {
    const { publisher, managedDns, nginx, certificates } = setup();
    const published = await publisher.publish(route);

    expect(published.ok && published.value.warnings).toEqual([]);
    expect(managedDns.ensure).toHaveBeenCalledWith(
      'app.example.com',
      '203.0.113.10',
      'cloudflare-1',
      'zone-1',
      {},
    );
    expect(nginx.saveSite.mock.calls[0]![1]).toMatchObject({
      domain: 'app.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 8400,
      websocket: true,
      clientMaxBodySize: '100m',
    });
    expect(managedDns.ensure.mock.invocationCallOrder[0]!).toBeLessThan(
      nginx.saveSite.mock.invocationCallOrder[0]!,
    );
    expect(nginx.saveSite.mock.invocationCallOrder[0]!).toBeLessThan(
      certificates.issue.mock.invocationCallOrder[0]!,
    );
  });

  it('passes the proxy choice to Cloudflare', async () => {
    const { publisher, managedDns } = setup();
    await publisher.publish({ ...route, proxied: false });
    expect(managedDns.ensure.mock.calls[0]![4]).toEqual({ proxied: false });
  });

  it('uses Let’s Encrypt for a DNS-only record, with the HTTP redirect on', async () => {
    const { publisher, certificates } = setup({ dns: { proxied: false } });
    await publisher.publish(route);
    expect(certificates.issue).toHaveBeenCalledTimes(1);
    expect(certificates.issue.mock.calls[0]![1]).toMatchObject({
      authority: 'letsencrypt',
      httpRedirect: true,
      email: 'ops@example.com',
    });
  });

  it('uses an Origin certificate behind the proxy and never changes the zone SSL mode', async () => {
    const { publisher, certificates } = setup({ dns: { proxied: true, sslMode: 'strict' } });
    const published = await publisher.publish(route);
    expect(published.ok && published.value.warnings).toEqual([]);
    expect(certificates.issue).toHaveBeenCalledTimes(1);
    expect(certificates.issue.mock.calls[0]![1]).toMatchObject({
      authority: 'cloudflare-origin-ca',
      keepCloudflareSslMode: true,
      httpRedirect: true,
      cloudflareCredentialId: 'cloudflare-1',
    });
  });

  it.each(['flexible', 'off', 'unknown'])(
    'does not redirect to HTTPS when the zone is %s, which would loop forever',
    async (sslMode) => {
      const { publisher, certificates } = setup({ dns: { proxied: true, sslMode } });
      await publisher.publish(route);
      expect(certificates.issue.mock.calls[0]![1]).toMatchObject({ httpRedirect: false });
    },
  );

  it('tells the user about a Flexible zone without changing it', async () => {
    const { publisher } = setup({ dns: { proxied: true, sslMode: 'flexible' } });
    const published = await publisher.publish(route);
    expect(published.ok && published.value.warnings[0]).toContain('Flexible');
  });

  it('falls back to Let’s Encrypt when the token cannot create an Origin certificate', async () => {
    const { publisher, certificates } = setup({ dns: { proxied: true, sslMode: 'full' } });
    certificates.issue.mockResolvedValueOnce(err(new DeploymentError('Authentication error')));
    const published = await publisher.publish(route);
    expect(published.ok && published.value.warnings).toEqual([]);
    expect(
      certificates.issue.mock.calls.map((call) => (call[1] as { authority: string }).authority),
    ).toEqual(['cloudflare-origin-ca', 'letsencrypt']);
  });

  it('reports both failures and keeps the site when no certificate can be issued', async () => {
    const { publisher, certificates, nginx } = setup({ dns: { proxied: true, sslMode: 'full' } });
    certificates.issue.mockResolvedValue(err(new DeploymentError('denied')));
    const published = await publisher.publish(route);
    expect(published.ok).toBe(true);
    expect(nginx.saveSite).toHaveBeenCalled();
    const warning = published.ok ? published.value.warnings.join(' ') : '';
    expect(warning).toContain('HTTPS is not enabled');
    expect(warning).toContain('SSL and Certificates');
  });

  it('does not issue another certificate when the site already has HTTPS', async () => {
    const { publisher, certificates } = setup({
      sites: [{ domain: 'app.example.com', managed: true, upstreamPort: 8400, ssl: true }],
    });
    await publisher.publish(route);
    expect(certificates.issue).not.toHaveBeenCalled();
  });

  it('skips HTTPS and warns while DNS is still propagating', async () => {
    const { publisher, certificates, nginx } = setup({
      dns: { status: 'pending', warning: 'Waiting for public edge DNS propagation.' },
    });
    const published = await publisher.publish(route);
    expect(nginx.saveSite).toHaveBeenCalled();
    expect(certificates.issue).not.toHaveBeenCalled();
    expect(published.ok && published.value.warnings.join(' ')).toContain('Waiting');
  });

  it('does not report the proxy explanation as a warning', async () => {
    const events: string[] = [];
    const { publisher } = setup({
      dns: { proxied: true, sslMode: 'strict', warning: 'Cloudflare proxy is enabled.' },
    });
    const published = await publisher.publish(route, (event) => events.push(event.message));
    expect(published.ok && published.value.warnings).toEqual([]);
    expect(events).toContain('Cloudflare proxy is enabled.');
  });

  it('turns a DNS refusal into a warning and still publishes the site', async () => {
    const { publisher, managedDns, nginx, certificates } = setup();
    managedDns.ensure.mockResolvedValueOnce(err(new DeploymentError('record points elsewhere')));
    const published = await publisher.publish(route);
    expect(published.ok && published.value.warnings[0]).toContain('record points elsewhere');
    expect(nginx.saveSite).toHaveBeenCalled();
    expect(certificates.issue).not.toHaveBeenCalled();
  });

  it('never repoints an Nginx site that serves another application', async () => {
    const other = setup({
      sites: [{ domain: 'app.example.com', managed: true, upstreamPort: 8010 }],
    });
    const published = await other.publisher.publish(route);
    expect(published.ok).toBe(false);
    expect(other.nginx.saveSite).not.toHaveBeenCalled();

    const foreign = setup({ sites: [{ domain: 'app.example.com', managed: false }] });
    expect((await foreign.publisher.publish(route)).ok).toBe(false);
  });

  it('needs no Cloudflare step for a domain managed elsewhere', async () => {
    const { publisher, managedDns, certificates } = setup();
    await publisher.publish({ ...route, cloudflareCredentialId: null, cloudflareZoneId: null });
    expect(managedDns.ensure).not.toHaveBeenCalled();
    expect(certificates.issue.mock.calls[0]![1]).toMatchObject({ authority: 'letsencrypt' });
  });
});

describe('DomainPublisher.unpublish', () => {
  const site = { domain: 'app.example.com', managed: true, upstreamPort: 8400 };

  it('removes the Nginx site, stops renewing the certificate and keeps DNS by default', async () => {
    const { publisher, nginx, certificates, managedDns } = setup({ sites: [site] });
    const removed = await publisher.unpublish(route, { deleteDns: false });
    expect(removed.ok).toBe(true);
    expect(nginx.removeSite).toHaveBeenCalledWith('target-1', 'app.example.com');
    expect(certificates.forget).toHaveBeenCalledWith('target-1', 'app.example.com');
    expect(managedDns.withdraw).not.toHaveBeenCalled();
  });

  it('withdraws the DNS record when asked', async () => {
    const { publisher, managedDns } = setup({ sites: [site] });
    await publisher.unpublish(route, { deleteDns: true });
    expect(managedDns.withdraw).toHaveBeenCalledWith(
      'app.example.com',
      '203.0.113.10',
      'cloudflare-1',
      'zone-1',
    );
  });

  it('leaves an Nginx site it does not manage', async () => {
    const { publisher, nginx } = setup({ sites: [{ ...site, managed: false }] });
    await publisher.unpublish(route, { deleteDns: false });
    expect(nginx.removeSite).not.toHaveBeenCalled();
  });
});
