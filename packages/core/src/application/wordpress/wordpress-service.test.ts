import { describe, expect, it, vi } from 'vitest';
import { DeploymentError, err, ok } from '@cloudforge/shared';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { ManagedNginxSite } from '../ports/nginx-manager.js';
import type {
  WordPressDeployment,
  WordPressRuntimeStatus,
  WordPressSiteRecord,
  WordPressSiteStore,
} from '../ports/wordpress-manager.js';
import { DomainPublisher } from '../domains/domain-publisher.js';
import { WordPressService } from './wordpress-service.js';

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:test',
};

const running: WordPressRuntimeStatus = {
  project: 'cloudforge-wp-blog-example-com',
  containers: [],
  wordpressVersion: '6.9',
  installed: true,
};

function memoryStore(initial: WordPressSiteRecord[] = []): WordPressSiteStore & {
  records: Map<string, WordPressSiteRecord>;
} {
  const records = new Map(initial.map((record) => [record.id, record]));
  return {
    records,
    list: () => Promise.resolve(ok([...records.values()])),
    save: (record) => {
      records.set(record.id, record);
      return Promise.resolve(ok(undefined));
    },
    remove: (id) => {
      records.delete(id);
      return Promise.resolve(ok(undefined));
    },
  };
}

function setup(
  options: {
    nginxSites?: ManagedNginxSite[];
    dnsRecords?: unknown[];
    owners?: string[];
  } = {},
) {
  const store = memoryStore();
  const manager = {
    deploy: vi.fn().mockResolvedValue(ok(running)),
    update: vi.fn().mockResolvedValue(ok({ ...running, wordpressVersion: '6.9.1' })),
    status: vi.fn().mockResolvedValue(ok(running)),
    remove: vi.fn().mockResolvedValue(ok(undefined)),
  };
  // A small encrypted-credential store: what was created can be listed and read back.
  const stored = new Map<string, { kind: string; name: string; content: string }>();
  const credentials = {
    create: vi
      .fn()
      .mockImplementation((input: { kind: string; name: string; data: { content: string } }) => {
        const id = `credential-${String(stored.size + 1)}`;
        stored.set(id, { kind: input.kind, name: input.name, content: input.data.content });
        return Promise.resolve(ok({ id }));
      }),
    list: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          ok([...stored].map(([id, item]) => ({ id, kind: item.kind, name: item.name }))),
        ),
      ),
    getDecrypted: vi.fn().mockImplementation((id: string) => {
      const item = stored.get(id);
      return Promise.resolve(
        item
          ? ok({ kind: item.kind, data: { content: item.content } })
          : err(new DeploymentError('missing')),
      );
    }),
    remove: vi.fn().mockImplementation((id: string) => {
      stored.delete(id);
      return Promise.resolve(ok(undefined));
    }),
  };
  const nginx = {
    listSites: vi.fn().mockResolvedValue(ok(options.nginxSites ?? [])),
    saveSite: vi.fn().mockResolvedValue(ok({ summary: 'saved' })),
    removeSite: vi.fn().mockResolvedValue(ok({ summary: 'removed' })),
  };
  const managedDns = {
    ensure: vi.fn().mockResolvedValue(ok({ status: 'propagated', warning: null })),
  };
  const certificates = { issue: vi.fn().mockResolvedValue(ok({ domain: 'blog.example.com' })) };
  const activities = { recordSafe: vi.fn() };
  const cloudflare = {
    dnsRecords: vi.fn().mockResolvedValue(ok(options.dnsRecords ?? [])),
  };
  const otherApps = { owners: vi.fn().mockResolvedValue(ok(options.owners ?? [])) };
  const targets = { resolve: vi.fn().mockResolvedValue(ok(target)) };
  const domains = new DomainPublisher(
    targets,
    nginx,
    managedDns,
    certificates,
    cloudflare,
    otherApps,
  );
  const service = new WordPressService(store, targets, manager, credentials, activities, domains);
  return {
    service,
    store,
    manager,
    credentials,
    nginx,
    managedDns,
    certificates,
    activities,
    cloudflare,
    otherApps,
    domains,
  };
}

function dnsRecord(name: string, type: string, content: string) {
  return { id: `${name}-${type}`, zoneId: 'zone-1', name, type, content };
}

const input = {
  targetId: 'target-1',
  domain: 'blog.example.com',
  siteTitle: 'Blog',
  adminUser: 'alex',
  adminEmail: 'alex@example.com',
  cloudflareCredentialId: 'cloudflare-1',
  https: true,
};

describe('WordPressService.create', () => {
  it('deploys the containers, then DNS, Nginx and HTTPS, and stores the passwords as a secret', async () => {
    const { service, store, manager, credentials, nginx, managedDns, certificates } = setup();
    const created = await service.create(input);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.site).toMatchObject({
      status: 'running',
      hostPort: 8300,
      project: 'cloudforge-wp-blog-example-com',
      wordpressVersion: '6.9',
      warnings: [],
    });
    expect(created.value.adminPassword).toMatch(/^[A-Za-z0-9]{20}$/);

    const deployment = manager.deploy.mock.calls[0]![1] as WordPressDeployment;
    expect(deployment.siteUrl).toBe('https://blog.example.com');
    expect(deployment.composeYaml).not.toContain(deployment.secrets.databasePassword);
    const secret = credentials.create.mock.calls[0]![0] as {
      kind: string;
      data: { content: string };
    };
    expect(secret.kind).toBe('environment-file');
    expect(secret.data.content).toContain(`DB_PASSWORD=${deployment.secrets.databasePassword}`);
    expect(secret.data.content).toContain(
      `WORDPRESS_ADMIN_PASSWORD=${created.value.adminPassword}`,
    );

    expect(managedDns.ensure).toHaveBeenCalledWith(
      'blog.example.com',
      '203.0.113.10',
      'cloudflare-1',
      undefined,
      {},
    );
    const site = nginx.saveSite.mock.calls[0]![1] as ManagedNginxSite;
    expect(site).toMatchObject({ upstreamHost: '127.0.0.1', upstreamPort: 8300, ssl: false });
    expect(certificates.issue).toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ domain: 'blog.example.com', authority: 'letsencrypt' }),
      expect.any(Function),
    );
    expect(store.records.size).toBe(1);
  });

  it('keeps a running site with a warning when HTTPS cannot be issued yet', async () => {
    const { service, certificates } = setup();
    certificates.issue.mockResolvedValueOnce(err(new Error('DNS does not point to this VPS')));
    const created = await service.create(input);

    expect(created.ok && created.value.site.status).toBe('running');
    expect(created.ok && created.value.site.warnings[0]).toContain('DNS does not point');
  });

  it('marks the site failed and keeps it when the containers do not start', async () => {
    const { service, store, manager, nginx } = setup();
    manager.deploy.mockResolvedValueOnce(err(new DeploymentError('Port 8300 is used')));
    const created = await service.create(input);

    expect(created.ok).toBe(false);
    expect([...store.records.values()][0]).toMatchObject({
      status: 'failed',
      lastError: 'Port 8300 is used',
    });
    expect(nginx.saveSite).not.toHaveBeenCalled();
  });

  it('refuses a second site for the same domain, and a domain another tool owns in Nginx', async () => {
    const first = setup();
    await first.service.create(input);
    expect((await first.service.create(input)).ok).toBe(false);

    const foreign = setup({
      nginxSites: [{ domain: 'blog.example.com', managed: false } as unknown as ManagedNginxSite],
    });
    const created = await foreign.service.create(input);
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.message).toContain('outside CloudForge');
    expect(foreign.manager.deploy).not.toHaveBeenCalled();
  });

  it('gives each site on a server its own port', async () => {
    const { service } = setup();
    await service.create(input);
    const second = await service.create({ ...input, domain: 'shop.example.com' });
    expect(second.ok && second.value.site.hostPort).toBe(8301);
  });
});

describe('WordPressService redeploy, update and remove', () => {
  it('redeploys with the same passwords that were stored', async () => {
    const { service, manager } = setup();
    const created = await service.create(input);
    if (!created.ok) throw new Error('create failed');
    const firstSecrets = (manager.deploy.mock.calls[0]![1] as WordPressDeployment).secrets;

    expect((await service.redeploy(created.value.site.id)).ok).toBe(true);
    expect((manager.deploy.mock.calls[1]![1] as WordPressDeployment).secrets).toEqual(firstSecrets);
  });

  it('records the new WordPress version after an update', async () => {
    const { service } = setup();
    const created = await service.create(input);
    if (!created.ok) throw new Error('create failed');
    const updated = await service.update(created.value.site.id);
    expect(updated.ok && updated.value.wordpressVersion).toBe('6.9.1');
  });

  it('reuses the passwords a Remove kept when the same domain is deployed again', async () => {
    const { service, manager, credentials } = setup();
    const first = await service.create(input);
    if (!first.ok) throw new Error('create failed');
    await service.remove(first.value.site.id, false);

    const again = await service.create({
      ...input,
      adminUser: 'someone-else',
      adminPassword: 'a brand new password',
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(credentials.create).toHaveBeenCalledTimes(1);
    expect(again.value.adminPassword).toBe(first.value.adminPassword);
    // WordPress keeps the account it was installed with.
    expect(again.value.site.adminUser).toBe('alex');
    expect(again.value.site.credentialId).toBe(first.value.site.credentialId);
    const deployments = manager.deploy.mock.calls.map(
      (call) => (call[1] as WordPressDeployment).secrets,
    );
    expect(deployments[1]).toEqual(deployments[0]);
  });

  it('keeps the passwords unless the data is deleted too', async () => {
    const kept = setup();
    const site = await kept.service.create(input);
    if (!site.ok) throw new Error('create failed');
    kept.nginx.listSites.mockResolvedValue(
      ok([{ domain: 'blog.example.com', managed: true } as ManagedNginxSite]),
    );
    expect((await kept.service.remove(site.value.site.id, false)).ok).toBe(true);
    expect(kept.manager.remove).toHaveBeenCalledWith(
      target,
      'cloudforge-wp-blog-example-com',
      false,
      undefined,
    );
    expect(kept.nginx.removeSite).toHaveBeenCalledWith('target-1', 'blog.example.com');
    expect(kept.credentials.remove).not.toHaveBeenCalled();
    expect(kept.store.records.size).toBe(0);

    const deleted = setup();
    const other = await deleted.service.create(input);
    if (!other.ok) throw new Error('create failed');
    await deleted.service.remove(other.value.site.id, true);
    expect(deleted.credentials.remove).toHaveBeenCalledWith('credential-1');
  });
});

describe('WordPressService and taken domains', () => {
  it('refuses to deploy on a taken domain before touching the server', async () => {
    const taken = setup({ dnsRecords: [dnsRecord('blog.example.com', 'A', '198.51.100.7')] });
    const created = await taken.service.create({ ...input, cloudflareZoneId: 'zone-1' });
    expect(created.ok).toBe(false);
    expect(taken.manager.deploy).not.toHaveBeenCalled();
    expect(taken.credentials.create).not.toHaveBeenCalled();
  });
});
