import { describe, expect, it } from 'vitest';
import type {
  ObservedContainer,
  ObservedNetwork,
  ObservedVolume,
  RuntimeObservation,
} from '../ports/runtime-inspector.js';
import { blockingDrift, detectRuntimeDrift } from './runtime-drift.js';
import { RUNTIME_LABELS } from './runtime-ownership.js';
import { emptyRuntimePlan, type RuntimeService, type VpsRuntimePlan } from './vps-runtime-plan.js';

const TARGET = 'target-1';

const ids = (report: { entries: readonly { id: string }[] }): string[] =>
  report.entries.map((e) => e.id);

const ownedLabels = (extra: Record<string, string> = {}): Record<string, string> => ({
  [RUNTIME_LABELS.managed]: 'true',
  [RUNTIME_LABELS.targetId]: TARGET,
  ...extra,
});

function plan(overrides: Partial<VpsRuntimePlan> = {}): VpsRuntimePlan {
  return { ...emptyRuntimePlan(TARGET), mode: 'managed', ...overrides };
}

function service(overrides: Partial<RuntimeService> = {}): RuntimeService {
  return {
    name: 'web',
    applicationName: 'app',
    kind: 'web',
    containerName: 'app-web',
    exposure: 'proxy-only',
    ports: [],
    networks: [],
    serviceReferences: [],
    volumes: [],
    restartPolicy: 'unless-stopped',
    ...overrides,
  };
}

function container(overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return {
    id: 'abc123abc123',
    name: 'app-web',
    image: 'nginx:1.25',
    state: 'running',
    status: 'Up 2 hours',
    health: null,
    createdAt: null,
    restartPolicy: 'unless-stopped',
    labels: {},
    ownership: 'unmanaged',
    composeProject: null,
    composeService: null,
    ports: [],
    networks: [],
    mounts: [],
    ...overrides,
  };
}

function network(overrides: Partial<ObservedNetwork> = {}): ObservedNetwork {
  return {
    id: 'net1',
    name: 'edge',
    driver: 'bridge',
    internal: false,
    attachable: true,
    ipv6: false,
    labels: {},
    ownership: 'unmanaged',
    containerNames: [],
    ...overrides,
  };
}

function volume(overrides: Partial<ObservedVolume> = {}): ObservedVolume {
  return {
    name: 'app-data',
    driver: 'local',
    mountPoint: '/var/lib/docker/volumes/app-data/_data',
    labels: {},
    ownership: 'unmanaged',
    containerNames: [],
    ...overrides,
  };
}

function observation(overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    targetId: TARGET,
    observedAt: '2026-01-01T00:00:00.000Z',
    docker: { available: true, version: '27.0.0', composeVersion: 'v2.29.0' },
    containers: [],
    networks: [],
    volumes: [],
    ...overrides,
  };
}

describe('detectRuntimeDrift', () => {
  it('reports nothing for an empty plan against an empty VPS', () => {
    const report = detectRuntimeDrift(plan(), observation());

    expect(report.inSync).toBe(true);
    expect(report.entries).toEqual([]);
    expect(report.counts).toEqual({ info: 0, warning: 0, error: 0 });
  });

  it('reports no drift in legacy mode, however busy the VPS is', () => {
    // The guarantee that makes upgrading CloudForge safe: an install that has
    // never been managed must look clean, not accuse a working server of drift.
    const report = detectRuntimeDrift(
      plan({ mode: 'legacy' }),
      observation({
        containers: [container({ name: 'someone-elses-app' }), container({ name: 'legacy-db' })],
        networks: [network({ name: 'bridge' })],
        volumes: [volume({ name: 'pgdata' })],
      }),
    );

    expect(report.inSync).toBe(true);
  });

  it('carries the plan version and observation timestamp into the report', () => {
    const report = detectRuntimeDrift(plan({ version: 7 }), observation());

    expect(report.planVersion).toBe(7);
    expect(report.observedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.targetId).toBe(TARGET);
  });

  it('refuses to compare an observation of a different target', () => {
    const report = detectRuntimeDrift(plan(), observation({ targetId: 'somewhere-else' }));

    expect(ids(report)).toEqual(['observation.mismatch']);
    expect(report.counts.error).toBe(1);
  });

  it('reports one finding when Docker is missing, not a page of derived ones', () => {
    const report = detectRuntimeDrift(
      plan({
        networks: [
          {
            name: 'edge',
            dockerName: 'edge',
            displayName: 'Edge',
            driver: 'bridge',
            scope: 'shared-proxy',
            internal: false,
            attachable: true,
            ipv6: false,
            labels: {},
          },
        ],
        applications: [
          { name: 'app', displayName: 'App', composeProject: 'app', sourceMode: 'hybrid-override' },
        ],
        services: [service()],
      }),
      observation({ docker: { available: false, version: null, composeVersion: null } }),
    );

    expect(ids(report)).toEqual(['docker.unavailable']);
  });

  describe('ownership', () => {
    const withNetwork = plan({
      networks: [
        {
          name: 'edge',
          dockerName: 'edge',
          displayName: 'Edge',
          driver: 'bridge',
          scope: 'shared-proxy',
          internal: false,
          attachable: true,
          ipv6: false,
          labels: {},
        },
      ],
    });

    it('treats an unmanaged name collision as a blocking conflict', () => {
      const report = detectRuntimeDrift(
        withNetwork,
        observation({ networks: [network({ name: 'edge', ownership: 'unmanaged' })] }),
      );

      expect(ids(report)).toEqual(['network.ownership-conflict']);
      expect(report.entries[0]?.severity).toBe('error');
      expect(report.entries[0]?.kind).toBe('ownership-conflict');
    });

    it('offers adoption for a resource an older release evidently created', () => {
      const report = detectRuntimeDrift(
        withNetwork,
        observation({ networks: [network({ name: 'edge', ownership: 'legacy-managed' })] }),
      );

      expect(ids(report)).toEqual(['network.adoptable']);
      expect(report.entries[0]?.kind).toBe('adoptable');
    });

    it.each(['cloudforge-managed', 'adopted'] as const)('accepts a %s resource', (ownership) => {
      const report = detectRuntimeDrift(
        withNetwork,
        observation({ networks: [network({ name: 'edge', ownership, labels: ownedLabels() })] }),
      );

      expect(report.inSync).toBe(true);
    });

    it('names conflicts and adoptions as the things a person must resolve', () => {
      const report = detectRuntimeDrift(
        withNetwork,
        observation({ networks: [network({ name: 'edge', ownership: 'unmanaged' })] }),
      );

      expect(blockingDrift(report).map((e) => e.id)).toEqual(['network.ownership-conflict']);
    });
  });

  describe('resources CloudForge no longer wants', () => {
    it('reports an owned network the plan dropped', () => {
      const report = detectRuntimeDrift(
        plan(),
        observation({
          networks: [
            network({ name: 'edge', ownership: 'cloudforge-managed', labels: ownedLabels() }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['network.unexpected']);
    });

    it('says an attached network cannot be removed', () => {
      const report = detectRuntimeDrift(
        plan(),
        observation({
          networks: [
            network({
              name: 'edge',
              ownership: 'cloudforge-managed',
              labels: ownedLabels(),
              containerNames: ['a', 'b'],
            }),
          ],
        }),
      );

      expect(report.entries[0]?.message).toContain('2 container(s) are still attached');
    });

    it('never calls an unowned resource unexpected', () => {
      // The rule the whole detector rests on: a VPS is full of things that are
      // not ours, and calling them drift invites deleting a user's work.
      const report = detectRuntimeDrift(
        plan(),
        observation({
          containers: [container({ name: 'their-db', ownership: 'unmanaged' })],
          networks: [network({ name: 'their-net', ownership: 'legacy-managed' })],
          volumes: [volume({ name: 'their-data', ownership: 'unmanaged' })],
        }),
      );

      expect(report.inSync).toBe(true);
    });

    it('ignores a labelled resource belonging to a different target', () => {
      // Two CloudForge targets can point at one host. Claiming the other's
      // containers as ours-but-undesired would propose deleting them.
      const report = detectRuntimeDrift(
        plan(),
        observation({
          containers: [
            container({
              name: 'other-web',
              ownership: 'cloudforge-managed',
              labels: { [RUNTIME_LABELS.managed]: 'true', [RUNTIME_LABELS.targetId]: 'target-2' },
            }),
          ],
        }),
      );

      expect(report.inSync).toBe(true);
    });

    it('ignores an owned-looking resource with no target label at all', () => {
      const report = detectRuntimeDrift(
        plan(),
        observation({
          containers: [
            container({
              name: 'mystery',
              ownership: 'cloudforge-managed',
              labels: { [RUNTIME_LABELS.managed]: 'true' },
            }),
          ],
        }),
      );

      expect(report.inSync).toBe(true);
    });

    it('reports a dropped volume as information and says it will not be removed', () => {
      const report = detectRuntimeDrift(
        plan(),
        observation({
          volumes: [
            volume({ name: 'app-data', ownership: 'cloudforge-managed', labels: ownedLabels() }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['volume.unexpected']);
      expect(report.entries[0]?.severity).toBe('info');
      expect(report.entries[0]?.message).toContain('never removed automatically');
    });
  });

  describe('networks', () => {
    const edge = {
      name: 'edge',
      dockerName: 'edge',
      displayName: 'Edge',
      driver: 'bridge',
      scope: 'shared-proxy',
      internal: false,
      attachable: true,
      ipv6: false,
      labels: {},
    } as const;

    it('reports a network that does not exist', () => {
      const report = detectRuntimeDrift(plan({ networks: [edge] }), observation());

      expect(ids(report)).toEqual(['network.missing']);
      expect(report.entries[0]?.expected).toBe('edge');
    });

    it('says a driver change means recreating the network', () => {
      const report = detectRuntimeDrift(
        plan({ networks: [{ ...edge, driver: 'overlay' }] }),
        observation({
          networks: [
            network({
              name: 'edge',
              driver: 'bridge',
              ownership: 'adopted',
              labels: ownedLabels(),
            }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['network.driver.modified']);
      expect(report.entries[0]?.message).toContain('requires recreating the network');
    });

    it('treats a network that should be internal but is not as an error', () => {
      const report = detectRuntimeDrift(
        plan({ networks: [{ ...edge, scope: 'application-private', internal: true }] }),
        observation({
          networks: [
            network({ name: 'edge', internal: false, ownership: 'adopted', labels: ownedLabels() }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['network.internal.modified']);
      expect(report.entries[0]?.severity).toBe('error');
    });

    it('treats an unexpectedly internal network as a warning', () => {
      const report = detectRuntimeDrift(
        plan({ networks: [edge] }),
        observation({
          networks: [
            network({ name: 'edge', internal: true, ownership: 'adopted', labels: ownedLabels() }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['network.internal.modified']);
      expect(report.entries[0]?.severity).toBe('warning');
    });
  });

  describe('services', () => {
    const app = {
      name: 'app',
      displayName: 'App',
      composeProject: 'app',
      sourceMode: 'cloudforge-managed',
    } as const;
    const edge = {
      name: 'edge',
      dockerName: 'edge-net',
      displayName: 'Edge',
      driver: 'bridge',
      scope: 'shared-proxy',
      internal: false,
      attachable: true,
      ipv6: false,
      labels: {},
    } as const;
    const base = (services: RuntimeService[]) =>
      plan({ applications: [app], networks: [edge], services });

    it('reports a container that does not exist', () => {
      const report = detectRuntimeDrift(
        plan({ applications: [app], services: [service()] }),
        observation(),
      );

      expect(ids(report)).toEqual(['container.missing']);
    });

    it('reports a container attached to none of its networks', () => {
      const report = detectRuntimeDrift(
        base([service({ networks: [{ networkName: 'edge', aliases: [] }] })]),
        observation({
          containers: [container({ ownership: 'cloudforge-managed', labels: ownedLabels() })],
          networks: [network({ name: 'edge-net', ownership: 'adopted', labels: ownedLabels() })],
        }),
      );

      expect(ids(report)).toEqual(['container.network.missing']);
      expect(report.entries[0]?.expected).toBe('edge-net');
    });

    it('treats a missing DNS alias as an error, because nothing can reach it', () => {
      const report = detectRuntimeDrift(
        base([service({ networks: [{ networkName: 'edge', aliases: ['web', 'frontend'] }] })]),
        observation({
          containers: [
            container({
              ownership: 'cloudforge-managed',
              labels: ownedLabels(),
              networks: [{ network: 'edge-net', aliases: ['web'], ipAddress: '172.18.0.2' }],
            }),
          ],
          networks: [network({ name: 'edge-net', ownership: 'adopted', labels: ownedLabels() })],
        }),
      );

      expect(ids(report)).toEqual(['container.alias.missing']);
      expect(report.entries[0]?.severity).toBe('error');
      expect(report.entries[0]?.message).toContain('frontend');
    });

    it('reports an extra network only for a container CloudForge fully owns', () => {
      const report = detectRuntimeDrift(
        base([service({ networks: [{ networkName: 'edge', aliases: [] }] })]),
        observation({
          containers: [
            container({
              ownership: 'cloudforge-managed',
              labels: ownedLabels(),
              networks: [
                { network: 'edge-net', aliases: [], ipAddress: null },
                { network: 'app_default', aliases: [], ipAddress: null },
              ],
            }),
          ],
          networks: [network({ name: 'edge-net', ownership: 'adopted', labels: ownedLabels() })],
        }),
      );

      expect(ids(report)).toEqual(['container.network.unexpected']);
      expect(report.entries[0]?.severity).toBe('info');
    });

    it('does not call a repository-owned service’s own network drift', () => {
      // In hybrid mode the repository's Compose file legitimately creates its own
      // default network. Calling that drift would make the report useless for
      // every real migration.
      const report = detectRuntimeDrift(
        plan({
          applications: [{ ...app, sourceMode: 'hybrid-override' }],
          networks: [edge],
          services: [service({ networks: [{ networkName: 'edge', aliases: [] }] })],
        }),
        observation({
          containers: [
            container({
              ownership: 'cloudforge-managed',
              labels: ownedLabels(),
              networks: [
                { network: 'edge-net', aliases: [], ipAddress: null },
                { network: 'app_default', aliases: [], ipAddress: null },
              ],
            }),
          ],
          networks: [network({ name: 'edge-net', ownership: 'adopted', labels: ownedLabels() })],
        }),
      );

      expect(report.inSync).toBe(true);
    });

    it('still compares a container whose ownership is unresolved', () => {
      // Someone deciding whether to adopt needs to see what adopting would change.
      const report = detectRuntimeDrift(
        base([service({ networks: [{ networkName: 'edge', aliases: [] }] })]),
        observation({
          containers: [container({ ownership: 'legacy-managed' })],
          networks: [network({ name: 'edge-net', ownership: 'adopted', labels: ownedLabels() })],
        }),
      );

      expect(ids(report)).toEqual(['container.adoptable', 'container.network.missing']);
    });

    it('reports a stale plan version', () => {
      const report = detectRuntimeDrift(
        plan({ version: 5, applications: [app], services: [service()] }),
        observation({
          containers: [
            container({
              ownership: 'cloudforge-managed',
              labels: ownedLabels({ [RUNTIME_LABELS.planVersion]: '3' }),
              networks: [],
            }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['container.planVersion.stale']);
      expect(report.entries[0]?.actual).toBe('3');
      expect(report.entries[0]?.expected).toBe('5');
    });

    it('reports image and restart-policy differences as information', () => {
      const report = detectRuntimeDrift(
        plan({
          applications: [app],
          services: [service({ image: 'nginx:1.27', restartPolicy: 'always' })],
        }),
        observation({
          containers: [
            container({
              image: 'nginx:1.25',
              restartPolicy: 'unless-stopped',
              ownership: 'cloudforge-managed',
              labels: ownedLabels(),
            }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['container.image.modified', 'container.restartPolicy.modified']);
      expect(report.counts).toEqual({ info: 2, warning: 0, error: 0 });
    });

    it('does not compare an image the plan does not pin', () => {
      const report = detectRuntimeDrift(
        plan({ applications: [app], services: [service()] }),
        observation({
          containers: [
            container({
              image: 'whatever',
              ownership: 'cloudforge-managed',
              labels: ownedLabels(),
            }),
          ],
        }),
      );

      expect(report.inSync).toBe(true);
    });
  });

  describe('ports', () => {
    const app = {
      name: 'app',
      displayName: 'App',
      composeProject: 'app',
      sourceMode: 'cloudforge-managed',
    } as const;
    const withService = (svc: RuntimeService) => plan({ applications: [app], services: [svc] });
    const owned = (ports: ObservedContainer['ports']) =>
      observation({
        containers: [container({ ownership: 'cloudforge-managed', labels: ownedLabels(), ports })],
      });

    it('reports a port the plan publishes but the container does not', () => {
      const report = detectRuntimeDrift(
        withService(
          service({
            exposure: 'direct',
            ports: [{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }],
          }),
        ),
        owned([
          {
            containerPort: 80,
            protocol: 'tcp',
            hostPort: null,
            bindAddress: null,
            exposure: 'internal',
          },
        ]),
      );

      expect(ids(report)).toEqual(['container.port.missing']);
      expect(report.entries[0]?.expected).toBe('0.0.0.0:8080');
    });

    it('reports a port published somewhere other than planned', () => {
      const report = detectRuntimeDrift(
        withService(
          service({
            exposure: 'host-loopback',
            ports: [
              { containerPort: 80, protocol: 'tcp', hostPort: 8080, bindAddress: '127.0.0.1' },
            ],
          }),
        ),
        owned([
          {
            containerPort: 80,
            protocol: 'tcp',
            hostPort: 8080,
            bindAddress: '0.0.0.0',
            exposure: 'direct',
          },
        ]),
      );

      expect(ids(report)).toEqual(['container.port.modified']);
      expect(report.entries[0]?.expected).toBe('127.0.0.1:8080');
      expect(report.entries[0]?.actual).toBe('0.0.0.0:8080');
    });

    it('treats a port open to the internet that the plan calls internal as an error', () => {
      // The single most valuable thing this detector finds: a database the plan
      // describes as internal, answering on every interface.
      const report = detectRuntimeDrift(
        withService(
          service({
            name: 'db',
            containerName: 'app-db',
            exposure: 'internal',
            ports: [{ containerPort: 5432, protocol: 'tcp' }],
          }),
        ),
        observation({
          containers: [
            container({
              name: 'app-db',
              ownership: 'cloudforge-managed',
              labels: ownedLabels(),
              ports: [
                {
                  containerPort: 5432,
                  protocol: 'tcp',
                  hostPort: 5432,
                  bindAddress: '0.0.0.0',
                  exposure: 'direct',
                },
              ],
            }),
          ],
        }),
      );

      expect(ids(report)).toEqual(['container.port.unexpected']);
      expect(report.entries[0]?.severity).toBe('error');
      expect(report.entries[0]?.message).toContain('reachable from outside the VPS');
    });

    it('reports a publicly reachable surprise even on a container we do not own', () => {
      const report = detectRuntimeDrift(
        withService(service({ exposure: 'proxy-only' })),
        observation({
          containers: [
            container({
              ownership: 'unmanaged',
              ports: [
                {
                  containerPort: 80,
                  protocol: 'tcp',
                  hostPort: 80,
                  bindAddress: '0.0.0.0',
                  exposure: 'direct',
                },
              ],
            }),
          ],
        }),
      );

      expect(ids(report)).toContain('container.port.unexpected');
    });

    it('treats an extra loopback-only port as information', () => {
      const report = detectRuntimeDrift(
        withService(service({ exposure: 'proxy-only' })),
        owned([
          {
            containerPort: 9000,
            protocol: 'tcp',
            hostPort: 9000,
            bindAddress: '127.0.0.1',
            exposure: 'host-loopback',
          },
        ]),
      );

      expect(ids(report)).toEqual(['container.port.unexpected']);
      expect(report.entries[0]?.severity).toBe('info');
    });

    it('does not confuse tcp and udp on the same port number', () => {
      const report = detectRuntimeDrift(
        withService(
          service({
            exposure: 'direct',
            ports: [{ containerPort: 53, protocol: 'udp', hostPort: 53 }],
          }),
        ),
        owned([
          {
            containerPort: 53,
            protocol: 'udp',
            hostPort: 53,
            bindAddress: '0.0.0.0',
            exposure: 'direct',
          },
        ]),
      );

      expect(report.inSync).toBe(true);
    });

    it('ignores a merely exposed port the plan does not publish', () => {
      const report = detectRuntimeDrift(
        withService(
          service({ exposure: 'proxy-only', ports: [{ containerPort: 80, protocol: 'tcp' }] }),
        ),
        owned([
          {
            containerPort: 80,
            protocol: 'tcp',
            hostPort: null,
            bindAddress: null,
            exposure: 'internal',
          },
        ]),
      );

      expect(report.inSync).toBe(true);
    });
  });

  describe('volumes', () => {
    it('reports a volume that does not exist', () => {
      const report = detectRuntimeDrift(
        plan({ volumes: [{ name: 'data', dockerName: 'app-data' }] }),
        observation(),
      );

      expect(ids(report)).toEqual(['volume.missing']);
    });

    it('will not take over an unmanaged volume', () => {
      const report = detectRuntimeDrift(
        plan({ volumes: [{ name: 'data', dockerName: 'app-data' }] }),
        observation({ volumes: [volume({ name: 'app-data', ownership: 'unmanaged' })] }),
      );

      expect(ids(report)).toEqual(['volume.ownership-conflict']);
    });
  });

  it('counts findings by severity', () => {
    const report = detectRuntimeDrift(
      plan({
        networks: [
          {
            name: 'edge',
            dockerName: 'edge',
            displayName: 'Edge',
            driver: 'bridge',
            scope: 'shared-proxy',
            internal: false,
            attachable: true,
            ipv6: false,
            labels: {},
          },
        ],
        volumes: [{ name: 'data', dockerName: 'app-data' }],
      }),
      observation({ volumes: [volume({ name: 'app-data', ownership: 'unmanaged' })] }),
    );

    expect(report.counts).toEqual({ info: 0, warning: 1, error: 1 });
    expect(report.inSync).toBe(false);
  });
});
