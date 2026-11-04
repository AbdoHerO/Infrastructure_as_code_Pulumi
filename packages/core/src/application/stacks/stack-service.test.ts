import { describe, expect, it, vi } from 'vitest';
import { DeploymentError, err, ok } from '@cloudforge/shared';
import type { DeploymentTarget } from '../ports/deployer.js';
import type {
  ComposeAnalysis,
  StackDeployment,
  StackRecord,
  StackRuntimeStatus,
  StackStore,
} from '../ports/stack-manager.js';
import { nextStackPort, validateStack, type StackInput } from './stack-definition.js';
import { StackService } from './stack-service.js';

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:test',
};

const analysis: ComposeAnalysis = {
  name: null,
  services: [
    {
      name: 'rustfs',
      image: 'rustfs/rustfs:1.0.4',
      containerName: 'rustfs.prod',
      ports: [],
      hostNetwork: false,
    },
  ],
  externalNetworks: ['backend.preprod'],
  externalVolumes: ['rustfs.prod'],
  errors: [],
  warnings: [],
};

const running: StackRuntimeStatus = {
  project: 'rustfs',
  containers: [
    {
      service: 'rustfs',
      name: 'rustfs.prod',
      state: 'running',
      health: '',
      image: 'rustfs/rustfs:1.0.4',
    },
  ],
  ports: [{ port: 8400, state: 'open' }],
};

const input: StackInput = {
  targetId: 'target-1',
  name: 'rustfs',
  composeYaml: 'services:\n  rustfs:\n    image: rustfs/rustfs:1.0.4\n',
  environment: 'RUSTFS_SECRET_KEY=secret\n',
  certificateEmail: 'ops@example.com',
  routes: [
    {
      domain: 'files.example.com',
      service: 'rustfs',
      containerPort: 9001,
      cloudflareCredentialId: 'cloudflare-1',
      cloudflareZoneId: 'zone-1',
      proxied: false,
      https: true,
    },
  ],
};

function setup(options: { analysis?: ComposeAnalysis; usedPorts?: number[] } = {}) {
  const records = new Map<string, StackRecord>();
  const store: StackStore = {
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
  const manager = {
    deploy: vi.fn().mockResolvedValue(ok(running)),
    status: vi.fn().mockResolvedValue(ok(running)),
    remove: vi.fn().mockResolvedValue(ok(undefined)),
    usedPorts: vi.fn().mockResolvedValue(ok(options.usedPorts ?? [22, 80, 443, 3000])),
  };
  const analyzer = { analyze: vi.fn().mockReturnValue(options.analysis ?? analysis) };
  const secrets = new Map<string, { kind: string; name: string; data: Record<string, string> }>();
  const credentials = {
    create: vi
      .fn()
      .mockImplementation((value: { kind: string; name: string; data: Record<string, string> }) => {
        const id = `credential-${String(secrets.size + 1)}`;
        secrets.set(id, value);
        return Promise.resolve(ok({ id }));
      }),
    update: vi
      .fn()
      .mockImplementation(
        (value: { id: string; kind: string; name: string; data: Record<string, string> }) => {
          secrets.set(value.id, value);
          return Promise.resolve(ok({ id: value.id }));
        },
      ),
    list: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          ok([...secrets].map(([id, value]) => ({ id, kind: value.kind, name: value.name }))),
        ),
      ),
    getDecrypted: vi.fn().mockImplementation((id: string) => {
      const secret = secrets.get(id);
      return Promise.resolve(secret ? ok(secret) : err(new DeploymentError('missing')));
    }),
    remove: vi.fn().mockImplementation((id: string) => {
      secrets.delete(id);
      return Promise.resolve(ok(undefined));
    }),
  };
  const activities = { recordSafe: vi.fn() };
  const domains = {
    check: vi
      .fn()
      .mockImplementation((query: { domain: string }) =>
        Promise.resolve(ok({ domain: query.domain, available: true, conflicts: [], notes: [] })),
      ),
    publish: vi.fn().mockResolvedValue(ok({ warnings: [] })),
    unpublish: vi.fn().mockResolvedValue(ok({ warnings: [] })),
  };
  const service = new StackService(
    store,
    { resolve: vi.fn().mockResolvedValue(ok(target)) },
    manager,
    analyzer,
    credentials,
    activities,
    domains,
  );
  return { service, records, manager, analyzer, credentials, secrets, domains, activities };
}

describe('validateStack', () => {
  it('normalizes a route and applies the default upload limit', () => {
    const valid = validateStack(
      { ...input, routes: [{ ...input.routes[0]!, domain: ' Files.Example.COM. ' }] },
      analysis,
    );
    expect(valid.ok && valid.value.routes[0]).toMatchObject({
      domain: 'files.example.com',
      clientMaxBodySize: '100m',
      proxied: false,
      hostPort: null,
    });
  });

  const route = input.routes[0]!;
  it.each([
    ['no server', { targetId: ' ' }],
    ['a name with capitals', { name: 'RustFS' }],
    ['a name with a slash', { name: 'a/b' }],
    ['an empty Compose file', { composeYaml: '  ' }],
    ['an unknown service', { routes: [{ ...route, service: 'nope' }] }],
    ['an invalid domain', { routes: [{ ...route, domain: 'not a domain' }] }],
    ['a domain listed twice', { routes: [route, { ...route, containerPort: 9000 }] }],
    ['a container port of zero', { routes: [{ ...route, containerPort: 0 }] }],
    ['a privileged local port', { routes: [{ ...route, hostPort: 80 }] }],
    ['a bad upload limit', { routes: [{ ...route, clientMaxBodySize: 'lots' }] }],
    ['HTTPS without an email', { certificateEmail: '' }],
    ['HTTPS with a bad email', { certificateEmail: 'nope' }],
  ])('refuses %s', (_name, change) => {
    expect(validateStack({ ...input, ...change }, analysis).ok).toBe(false);
  });

  it('accepts a stack with no domain, and needs no email then', () => {
    expect(validateStack({ ...input, routes: [], certificateEmail: null }, analysis).ok).toBe(true);
  });

  it('refuses what the Compose analysis found wrong', () => {
    const broken = validateStack(input, { ...analysis, errors: ['It builds from source.'] });
    expect(!broken.ok && broken.error.message).toContain('builds from source');
  });

  it('refuses a domain on a service that uses the host network', () => {
    const host = {
      ...analysis,
      services: [{ ...analysis.services[0]!, hostNetwork: true }],
    };
    expect(validateStack(input, host).ok).toBe(false);
  });
});

describe('nextStackPort', () => {
  it('skips taken ports', () => {
    expect(nextStackPort(new Set())).toBe(8400);
    expect(nextStackPort(new Set([8400, 8401, 8403]))).toBe(8402);
  });
});

describe('StackService.create', () => {
  it('deploys the stack, then publishes its domain, and keeps the files encrypted', async () => {
    const { service, records, manager, domains, secrets } = setup();
    const created = await service.create(input);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({ status: 'running', warnings: [], lastError: null });
    expect(created.value.routes[0]?.hostPort).toBe(8400);

    const deployment = manager.deploy.mock.calls[0]![1] as StackDeployment;
    expect(deployment).toMatchObject({
      project: 'rustfs',
      composeYaml: input.composeYaml,
      environment: input.environment,
      externalNetworks: ['backend.preprod'],
      externalVolumes: ['rustfs.prod'],
      containerNames: ['rustfs.prod'],
      hostPorts: [8400],
    });
    expect(deployment.overrideYaml).toContain('127.0.0.1:8400:9001');

    expect(domains.publish.mock.calls[0]![0]).toMatchObject({
      domain: 'files.example.com',
      hostPort: 8400,
      cloudflareCredentialId: 'cloudflare-1',
      cloudflareZoneId: 'zone-1',
      proxied: false,
      https: true,
      certificateEmail: 'ops@example.com',
      websocket: true,
    });
    expect(manager.deploy.mock.invocationCallOrder[0]!).toBeLessThan(
      domains.publish.mock.invocationCallOrder[0]!,
    );

    // Secrets stay in the encrypted credential, never in the plain record.
    const stored = JSON.stringify([...records.values()]);
    expect(stored).not.toContain('RUSTFS_SECRET_KEY');
    expect(stored).not.toContain('image:');
    expect([...secrets.values()][0]).toMatchObject({
      kind: 'docker-stack',
      name: 'Docker stack · rustfs',
      data: { composeYaml: input.composeYaml, environment: input.environment },
    });
  });

  it('blocks a taken domain before anything reaches the server', async () => {
    const { service, manager, domains, credentials, records } = setup();
    domains.check.mockResolvedValueOnce(
      ok({
        domain: 'files.example.com',
        available: false,
        conflicts: ['Docker stack other already uses files.example.com.'],
        notes: [],
      }),
    );
    const created = await service.create(input);

    expect(!created.ok && created.error.message).toContain('already uses');
    expect(manager.deploy).not.toHaveBeenCalled();
    expect(manager.usedPorts).not.toHaveBeenCalled();
    expect(credentials.create).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });

  it('checks every domain, and refuses when the second one is taken', async () => {
    const { service, manager, domains } = setup();
    domains.check
      .mockResolvedValueOnce(ok({ domain: 'a', available: true, conflicts: [], notes: [] }))
      .mockResolvedValueOnce(
        ok({ domain: 'b', available: false, conflicts: ['taken'], notes: [] }),
      );
    const created = await service.create({
      ...input,
      routes: [
        input.routes[0]!,
        { ...input.routes[0]!, domain: 's3.example.com', containerPort: 9000 },
      ],
    });
    expect(created.ok).toBe(false);
    expect(manager.deploy).not.toHaveBeenCalled();
  });

  it('skips local ports the server already uses, and gives each domain its own', async () => {
    const { service } = setup({ usedPorts: [8400, 8402] });
    const created = await service.create({
      ...input,
      routes: [
        input.routes[0]!,
        { ...input.routes[0]!, domain: 's3.example.com', containerPort: 9000 },
      ],
    });
    expect(created.ok && created.value.routes.map((route) => route.hostPort)).toEqual([8401, 8403]);
  });

  it('refuses a requested port that is taken, and takes a free one', async () => {
    const taken = setup({ usedPorts: [9100] });
    const refused = await taken.service.create({
      ...input,
      routes: [{ ...input.routes[0]!, hostPort: 9100 }],
    });
    expect(!refused.ok && refused.error.message).toContain('Port 9100');
    expect(taken.manager.deploy).not.toHaveBeenCalled();

    const free = setup({ usedPorts: [] });
    const accepted = await free.service.create({
      ...input,
      routes: [{ ...input.routes[0]!, hostPort: 9100 }],
    });
    expect(accepted.ok && accepted.value.routes[0]?.hostPort).toBe(9100);
  });

  it('does not reuse a port of another stack on the same server', async () => {
    const { service } = setup({ usedPorts: [] });
    await service.create(input);
    const second = await service.create({
      ...input,
      name: 'second',
      routes: [{ ...input.routes[0]!, domain: 'second.example.com' }],
    });
    expect(second.ok && second.value.routes[0]?.hostPort).toBe(8401);
  });

  it('refuses a second stack with the same name on the server', async () => {
    const { service } = setup();
    await service.create(input);
    const again = await service.create(input);
    expect(!again.ok && again.error.message).toContain('already exists');
  });

  it('deploys a stack with no domain without asking for ports or publishing', async () => {
    const { service, manager, domains } = setup();
    const created = await service.create({ ...input, routes: [], certificateEmail: null });
    expect(created.ok).toBe(true);
    expect(manager.usedPorts).not.toHaveBeenCalled();
    expect(domains.publish).not.toHaveBeenCalled();
  });

  it('marks the stack failed and keeps it when the containers do not start', async () => {
    const { service, records, manager, domains } = setup();
    manager.deploy.mockResolvedValueOnce(err(new DeploymentError('pull access denied')));
    const created = await service.create(input);

    expect(created.ok).toBe(false);
    expect([...records.values()][0]).toMatchObject({
      status: 'failed',
      lastError: 'pull access denied',
    });
    expect(domains.publish).not.toHaveBeenCalled();
  });

  it('marks the stack failed when its domain cannot be published', async () => {
    const { service, records, domains } = setup();
    domains.publish.mockResolvedValueOnce(err(new DeploymentError('Nginx refused the site')));
    await service.create(input);
    expect([...records.values()][0]?.status).toBe('failed');
  });

  it('reports what is wrong without failing a running stack', async () => {
    const { service, manager, domains } = setup();
    manager.deploy.mockResolvedValueOnce(
      ok({
        project: 'rustfs',
        containers: [
          { service: 'rustfs', name: 'rustfs.prod', state: 'restarting', health: '', image: 'x' },
        ],
        ports: [{ port: 8400, state: 'closed' }],
      }),
    );
    domains.publish.mockResolvedValueOnce(ok({ warnings: ['HTTPS is not enabled yet.'] }));
    const created = await service.create(input);

    expect(created.ok && created.value.status).toBe('running');
    const warnings = created.ok ? created.value.warnings.join(' ') : '';
    expect(warnings).toContain('restarting');
    expect(warnings).toContain('Nothing answered on port 9001');
    expect(warnings).toContain('HTTPS is not enabled yet.');
  });
});

describe('StackService after creation', () => {
  async function created() {
    const context = setup();
    const stack = await context.service.create(input);
    if (!stack.ok) throw new Error('create failed');
    return { ...context, stack: stack.value };
  }

  it('reveals the saved files on request', async () => {
    const { service, stack } = await created();
    const files = await service.reveal(stack.id);
    expect(files.ok && files.value).toEqual({
      composeYaml: input.composeYaml,
      environment: input.environment,
    });
  });

  it('saves an edit and deploys it, keeping the domain and its port', async () => {
    const { service, stack, manager, credentials } = await created();
    const updated = await service.update(stack.id, {
      composeYaml: 'services:\n  rustfs:\n    image: rustfs/rustfs:2.0.0\n',
      environment: 'A=1\n',
    });

    expect(updated.ok).toBe(true);
    expect(credentials.create).toHaveBeenCalledTimes(1);
    expect(credentials.update).toHaveBeenCalledTimes(1);
    const deployment = manager.deploy.mock.calls[1]![1] as StackDeployment;
    expect(deployment.composeYaml).toContain('2.0.0');
    expect(deployment.environment).toBe('A=1\n');
    expect(deployment.hostPorts).toEqual([8400]);
  });

  it('refuses an edit that removes the service a domain goes to', async () => {
    const { service, stack, analyzer, manager, credentials } = await created();
    analyzer.analyze.mockReturnValueOnce({ ...analysis, services: [] });
    const updated = await service.update(stack.id, { composeYaml: 'x', environment: '' });
    expect(!updated.ok && updated.error.message).toContain('no longer in the Compose file');
    expect(manager.deploy).toHaveBeenCalledTimes(1);
    expect(credentials.update).not.toHaveBeenCalled();
  });

  it('redeploys with the saved files', async () => {
    const { service, stack, manager } = await created();
    expect((await service.redeploy(stack.id)).ok).toBe(true);
    expect(manager.deploy).toHaveBeenCalledTimes(2);
    expect((manager.deploy.mock.calls[1]![1] as StackDeployment).composeYaml).toBe(
      input.composeYaml,
    );
  });

  it('clears an old failure once a redeploy works', async () => {
    const { service, stack, manager, records } = await created();
    manager.deploy.mockResolvedValueOnce(err(new DeploymentError('boom')));
    await service.redeploy(stack.id);
    expect(records.get(stack.id)?.status).toBe('failed');
    await service.redeploy(stack.id);
    expect(records.get(stack.id)).toMatchObject({ status: 'running', lastError: null });
  });

  it('checks the status on the stack’s own ports', async () => {
    const { service, stack, manager } = await created();
    await service.status(stack.id);
    expect(manager.status).toHaveBeenCalledWith(target, 'rustfs', [8400]);
  });

  it('keeps the data, the DNS and the saved files on Remove', async () => {
    const { service, stack, manager, domains, credentials, records } = await created();
    const removed = await service.remove(stack.id, false);

    expect(removed.ok).toBe(true);
    expect(manager.remove).toHaveBeenCalledWith(target, 'rustfs', false, undefined);
    expect(domains.unpublish).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'files.example.com' }),
      { deleteDns: false },
      undefined,
    );
    expect(credentials.remove).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });

  it('brings a removed stack back with one secret, replaced by the new files', async () => {
    const { service, stack, credentials, secrets } = await created();
    await service.remove(stack.id, false);
    const again = await service.create({ ...input, environment: 'NEW=1\n' });

    expect(again.ok).toBe(true);
    expect(credentials.create).toHaveBeenCalledTimes(1);
    expect(secrets.size).toBe(1);
    expect([...secrets.values()][0]?.data.environment).toBe('NEW=1\n');
  });

  it('deletes the data, DNS and saved files on Delete', async () => {
    const { service, stack, manager, domains, credentials } = await created();
    await service.remove(stack.id, true);
    expect(manager.remove).toHaveBeenCalledWith(target, 'rustfs', true, undefined);
    expect(domains.unpublish.mock.calls[0]![1]).toEqual({ deleteDns: true });
    expect(credentials.remove).toHaveBeenCalledWith(stack.credentialId);
  });

  it('keeps the record when the server refuses to remove the stack', async () => {
    const { service, stack, manager, records } = await created();
    manager.remove.mockResolvedValueOnce(err(new DeploymentError('not created by CloudForge')));
    expect((await service.remove(stack.id, true)).ok).toBe(false);
    expect(records.size).toBe(1);
  });
});
