import { describe, expect, it } from 'vitest';
import {
  parseContainerPorts,
  parseContainers,
  parseJsonLines,
  parseNetworks,
  parseVolumes,
} from './docker-inspect.js';

const lines = (...values: unknown[]): string =>
  values.map((value) => JSON.stringify(value)).join('\n');

describe('parseJsonLines', () => {
  it('skips an unreadable line rather than losing the whole sweep', () => {
    expect(parseJsonLines<{ a: number }>('{"a":1}\nnot json\n{"a":2}')).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it('tolerates blank lines and trailing newlines', () => {
    expect(parseJsonLines<{ a: number }>('\n{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });
});

describe('parseContainerPorts', () => {
  it('reports a port exposed inside Docker but not published', () => {
    // `docker ps` renders this as "8080/tcp" — indistinguishable at a glance
    // from a published port, though nothing outside Docker can reach it.
    expect(parseContainerPorts({ Config: { ExposedPorts: { '8080/tcp': {} } } })).toEqual([
      {
        containerPort: 8080,
        protocol: 'tcp',
        hostPort: null,
        bindAddress: null,
        exposure: 'internal',
      },
    ]);
  });

  it('reports a port published to every interface as directly exposed', () => {
    const ports = parseContainerPorts({
      Config: { ExposedPorts: { '80/tcp': {} } },
      NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }] } },
    });

    expect(ports).toEqual([
      {
        containerPort: 80,
        protocol: 'tcp',
        hostPort: 80,
        bindAddress: '0.0.0.0',
        exposure: 'direct',
      },
    ]);
  });

  it('distinguishes a loopback publish from a public one', () => {
    // The difference between "reachable from the VPS" and "reachable from the
    // internet" — invisible in the `docker ps` string the UI used to render.
    const ports = parseContainerPorts({
      NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] } },
    });

    expect(ports[0]).toMatchObject({ exposure: 'host-loopback', bindAddress: '127.0.0.1' });
  });

  it('does not double-count a port that is both exposed and published', () => {
    const ports = parseContainerPorts({
      Config: { ExposedPorts: { '80/tcp': {} } },
      NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } },
    });

    expect(ports).toHaveLength(1);
    expect(ports[0]?.hostPort).toBe(8080);
  });

  it('keeps both bindings when Docker publishes on IPv4 and IPv6', () => {
    const ports = parseContainerPorts({
      NetworkSettings: {
        Ports: {
          '443/tcp': [
            { HostIp: '0.0.0.0', HostPort: '443' },
            { HostIp: '::', HostPort: '443' },
          ],
        },
      },
    });

    // Docker really did open both; collapsing them would understate exposure.
    expect(ports).toHaveLength(2);
    expect(ports.every((port) => port.exposure === 'direct')).toBe(true);
  });

  it('treats an exposed port with a null binding list as internal', () => {
    expect(parseContainerPorts({ NetworkSettings: { Ports: { '5432/tcp': null } } })).toEqual([
      {
        containerPort: 5432,
        protocol: 'tcp',
        hostPort: null,
        bindAddress: null,
        exposure: 'internal',
      },
    ]);
  });

  it('falls back to the declared bindings for a stopped container', () => {
    // A stopped container reports no live bindings, only its intent.
    const ports = parseContainerPorts({
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] } },
    });

    expect(ports[0]).toMatchObject({ hostPort: 8080, bindAddress: '0.0.0.0', exposure: 'direct' });
  });

  it('preserves the protocol and rejects a malformed spec', () => {
    expect(parseContainerPorts({ Config: { ExposedPorts: { '53/udp': {} } } })[0]?.protocol).toBe(
      'udp',
    );
    expect(parseContainerPorts({ Config: { ExposedPorts: { bogus: {}, '0/tcp': {} } } })).toEqual(
      [],
    );
  });
});

describe('parseContainers', () => {
  const raw = {
    Id: 'abc123',
    Name: '/api',
    Created: '2026-01-01T00:00:00Z',
    State: { Status: 'running', Health: { Status: 'healthy' } },
    Config: {
      Image: 'node:20-alpine',
      Labels: {
        'com.docker.compose.project': 'shop',
        'com.docker.compose.service': 'api',
        'io.cloudforge.managed': 'true',
      },
      ExposedPorts: { '3000/tcp': {} },
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: {
      Networks: { 'shop-backend': { Aliases: ['api'], IPAddress: '172.20.0.3' } },
    },
    Mounts: [{ Type: 'volume', Name: 'shop-data', Destination: '/data', RW: true }],
  };

  it('reads identity, health, compose grouping and networks', () => {
    const [container] = parseContainers(lines(raw));

    expect(container).toMatchObject({
      id: 'abc123',
      name: 'api',
      image: 'node:20-alpine',
      state: 'running',
      health: 'healthy',
      restartPolicy: 'unless-stopped',
      composeProject: 'shop',
      composeService: 'api',
    });
    expect(container?.networks).toEqual([
      { network: 'shop-backend', aliases: ['api'], ipAddress: '172.20.0.3' },
    ]);
  });

  it('reads ownership from the labels Docker already returns', () => {
    // Labels and networks were both present in the payload all along and simply
    // discarded by the old six-field mapper.
    expect(parseContainers(lines(raw))[0]?.ownership).toBe('cloudforge-managed');
  });

  it('defaults an unlabelled container to unmanaged', () => {
    const foreign = { ...raw, Config: { ...raw.Config, Labels: {} } };

    expect(parseContainers(lines(foreign))[0]?.ownership).toBe('unmanaged');
  });

  it('recognises a container from a release that predates ownership labels', () => {
    const legacy = {
      ...raw,
      Config: {
        ...raw.Config,
        Labels: {
          'com.docker.compose.project': 'shop',
          'com.docker.compose.project.working_dir': '/opt/cloudforge/compose/shop',
        },
      },
    };

    // Evidence CloudForge created it, but not a claim of ownership: it stays
    // legacy-managed until a user adopts it.
    expect(parseContainers(lines(legacy))[0]?.ownership).toBe('legacy-managed');
  });

  it('strips the leading slash Docker puts on container names', () => {
    expect(parseContainers(lines(raw))[0]?.name).toBe('api');
  });

  it('defaults a container with no restart policy to no', () => {
    expect(parseContainers(lines({ ...raw, HostConfig: {} }))[0]?.restartPolicy).toBe('no');
  });

  it('skips a container with no id and keeps the rest', () => {
    expect(parseContainers(lines({ Name: '/broken' }, raw))).toHaveLength(1);
  });
});

describe('parseNetworks', () => {
  it('reads isolation flags and attached containers', () => {
    const [network] = parseNetworks(
      lines({
        Id: 'net1',
        Name: 'shop-backend',
        Driver: 'bridge',
        Internal: true,
        Attachable: false,
        EnableIPv6: false,
        Labels: { 'io.cloudforge.managed': 'true' },
        Containers: { abc: { Name: 'api' }, def: { Name: 'db' } },
      }),
    );

    expect(network).toMatchObject({
      name: 'shop-backend',
      internal: true,
      ownership: 'cloudforge-managed',
    });
    expect(network?.containerNames).toEqual(['api', 'db']);
  });

  it("does not claim Docker's own default networks", () => {
    const defaults = parseNetworks(
      lines(
        { Id: 'a', Name: 'bridge', Driver: 'bridge' },
        { Id: 'b', Name: 'host', Driver: 'host' },
      ),
    );

    expect(defaults.map((network) => network.ownership)).toEqual(['unmanaged', 'unmanaged']);
  });
});

describe('parseVolumes', () => {
  it('attributes a volume to the containers mounting it', () => {
    // `docker volume inspect` never reports its users, so without this a volume
    // holding a running database looks safe to delete.
    const containers = parseContainers(
      lines({
        Id: 'abc',
        Name: '/db',
        Config: { Labels: {} },
        Mounts: [{ Type: 'volume', Name: 'shop-data', Destination: '/var/lib/mysql', RW: true }],
      }),
    );
    const [volume] = parseVolumes(
      lines({
        Name: 'shop-data',
        Driver: 'local',
        Mountpoint: '/var/lib/docker/volumes/shop-data',
      }),
      containers,
    );

    expect(volume?.containerNames).toEqual(['db']);
  });

  it('reports an unused volume with no users', () => {
    expect(parseVolumes(lines({ Name: 'orphan', Driver: 'local' }), [])[0]?.containerNames).toEqual(
      [],
    );
  });

  it('ignores bind mounts when attributing volumes', () => {
    const containers = parseContainers(
      lines({
        Id: 'abc',
        Name: '/web',
        Config: { Labels: {} },
        Mounts: [{ Type: 'bind', Source: '/etc/nginx', Destination: '/etc/nginx' }],
      }),
    );

    expect(parseVolumes(lines({ Name: 'etc' }), containers)[0]?.containerNames).toEqual([]);
  });
});
