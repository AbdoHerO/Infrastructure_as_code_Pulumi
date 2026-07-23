import { describe, expect, it } from 'vitest';
import type {
  ObservedContainer,
  ObservedNetwork,
  RuntimeObservation,
} from '../ports/runtime-inspector.js';
import {
  destructiveNames,
  executableOperations,
  hasDisruptiveOperations,
  NO_APPLY_OPTIONS,
  ownershipLabels,
  planRuntimeOperations,
} from './runtime-operations.js';
import { RUNTIME_LABELS } from './runtime-ownership.js';
import {
  emptyRuntimePlan,
  type RuntimeNetwork,
  type RuntimeService,
  type VpsRuntimePlan,
} from './vps-runtime-plan.js';

const TARGET = 'target-1';

const ids = (change: { operations: readonly { id: string }[] }): string[] =>
  change.operations.map((o) => o.id);

const ownedLabels = (extra: Record<string, string> = {}): Record<string, string> => ({
  [RUNTIME_LABELS.managed]: 'true',
  [RUNTIME_LABELS.targetId]: TARGET,
  ...extra,
});

const edge: RuntimeNetwork = {
  name: 'edge',
  dockerName: 'edge-net',
  displayName: 'Edge',
  driver: 'bridge',
  scope: 'shared-proxy',
  internal: false,
  attachable: true,
  ipv6: false,
  labels: {},
};

const app = {
  name: 'app',
  displayName: 'App',
  composeProject: 'app',
  sourceMode: 'cloudforge-managed',
} as const;

function plan(overrides: Partial<VpsRuntimePlan> = {}): VpsRuntimePlan {
  return {
    ...emptyRuntimePlan(TARGET),
    mode: 'managed',
    applications: [app],
    ...overrides,
  };
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
    status: 'Up',
    health: null,
    createdAt: null,
    restartPolicy: 'unless-stopped',
    labels: ownedLabels(),
    ownership: 'cloudforge-managed',
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
    name: 'edge-net',
    driver: 'bridge',
    internal: false,
    attachable: true,
    ipv6: false,
    labels: ownedLabels(),
    ownership: 'cloudforge-managed',
    containerNames: [],
    ...overrides,
  };
}

function observation(overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    targetId: TARGET,
    observedAt: '2026-01-01T00:00:00.000Z',
    docker: { available: true, version: '27.0.0', composeVersion: 'v2' },
    containers: [],
    networks: [],
    volumes: [],
    ...overrides,
  };
}

describe('planRuntimeOperations', () => {
  it('proposes nothing and refuses to apply in legacy mode', () => {
    // The load-bearing guarantee: an unmanaged install is never acted on.
    const change = planRuntimeOperations(
      plan({ mode: 'legacy', networks: [edge] }),
      observation({ containers: [container({ name: 'production-db' })] }),
    );

    expect(change.operations).toEqual([]);
    expect(change.applyable).toBe(false);
    expect(change.blockers[0]).toContain('legacy mode');
  });

  it('refuses to apply when Docker is unavailable', () => {
    const change = planRuntimeOperations(
      plan({ networks: [edge] }),
      observation({ docker: { available: false, version: null, composeVersion: null } }),
    );

    expect(change.operations).toEqual([]);
    expect(change.applyable).toBe(false);
  });

  describe('networks', () => {
    it('creates a network that does not exist', () => {
      const change = planRuntimeOperations(plan({ networks: [edge] }), observation());

      expect(ids(change)).toEqual(['network.create:edge-net']);
      expect(change.operations[0]?.risk).toBe('safe');
      expect(change.applyable).toBe(true);
    });

    it('proposes nothing for a network that already matches', () => {
      const change = planRuntimeOperations(
        plan({ networks: [edge] }),
        observation({ networks: [network()] }),
      );

      expect(change.operations).toEqual([]);
      expect(change.applyable).toBe(false);
    });

    it('refuses to apply while a name is held by something unowned', () => {
      const change = planRuntimeOperations(
        plan({ networks: [edge] }),
        observation({ networks: [network({ ownership: 'unmanaged', labels: {} })] }),
      );

      expect(change.operations).toEqual([]);
      expect(change.applyable).toBe(false);
      expect(change.blockers[0]).toContain('not created by CloudForge');
    });

    it('proceeds once the network has been adopted', () => {
      const change = planRuntimeOperations(
        plan({
          networks: [edge],
          adoptions: [
            { dockerName: 'edge-net', resourceKind: 'network', adoptedAt: '2026-01-01T00:00:00Z' },
          ],
        }),
        observation({ networks: [network({ ownership: 'unmanaged', labels: {} })] }),
      );

      expect(change.blockers).toEqual([]);
    });

    it('will not silently recreate a network whose driver changed', () => {
      // Recreating means detaching everything on it. That is a decision for a
      // person with the whole picture, not something an apply slips in.
      const change = planRuntimeOperations(
        plan({ networks: [{ ...edge, driver: 'overlay' }] }),
        observation({ networks: [network({ driver: 'bridge' })] }),
      );

      expect(ids(change)).toEqual(['network.recreate:edge-net']);
      expect(change.operations[0]?.kind).toBe('manual');
      expect(change.applyable).toBe(false);
      expect(change.operations[0]?.detail).toContain('will not do that automatically');
    });
  });

  describe('attachments', () => {
    const withWeb = (aliases: string[] = []) =>
      plan({
        networks: [edge],
        services: [service({ networks: [{ networkName: 'edge', aliases }] })],
      });

    it('attaches a container that is not on its network', () => {
      const change = planRuntimeOperations(
        withWeb(),
        observation({ containers: [container()], networks: [network()] }),
      );

      expect(ids(change)).toEqual(['container.attach:app-web:edge-net']);
      expect(change.operations[0]?.risk).toBe('safe');
      expect(change.operations[0]?.detail).toContain('nothing currently working stops');
    });

    it('does not try to attach a container that does not exist yet', () => {
      // It arrives with its own deployment. The only useful thing to say is so.
      const change = planRuntimeOperations(withWeb(), observation({ networks: [network()] }));

      expect(ids(change)).toEqual(['manual.redeploy:app-web']);
      expect(executableOperations(change)).toEqual([]);
    });

    it('treats adding an alias as disruptive, because Docker makes it a reconnect', () => {
      const change = planRuntimeOperations(
        withWeb(['web', 'frontend']),
        observation({
          containers: [
            container({ networks: [{ network: 'edge-net', aliases: ['web'], ipAddress: null }] }),
          ],
          networks: [network()],
        }),
      );

      expect(ids(change)).toEqual(['container.alias:app-web:edge-net']);
      expect(change.operations[0]?.risk).toBe('disruptive');
      expect(change.operations[0]?.summary).toContain('frontend');
      expect(hasDisruptiveOperations(change)).toBe(true);
    });

    it('proposes nothing when the aliases already match', () => {
      const change = planRuntimeOperations(
        withWeb(['web']),
        observation({
          containers: [
            container({ networks: [{ network: 'edge-net', aliases: ['web'], ipAddress: null }] }),
          ],
          networks: [network()],
        }),
      );

      expect(change.operations).toEqual([]);
    });

    it('detaches an owned container the plan no longer puts on the network', () => {
      const change = planRuntimeOperations(
        plan({ networks: [edge], services: [service({ networks: [] })] }),
        observation({
          containers: [
            container({ networks: [{ network: 'edge-net', aliases: [], ipAddress: null }] }),
          ],
          networks: [network({ containerNames: ['app-web'] })],
        }),
      );

      expect(ids(change)).toEqual(['container.detach:app-web:edge-net']);
      expect(change.operations[0]?.risk).toBe('disruptive');
    });

    it('never detaches a container CloudForge does not own', () => {
      const change = planRuntimeOperations(
        plan({ networks: [edge], services: [service({ networks: [] })] }),
        observation({
          containers: [container({ ownership: 'unmanaged', labels: {} })],
          networks: [network({ containerNames: ['app-web'] })],
        }),
      );

      expect(change.operations).toEqual([]);
    });

    it('never detaches a container that is not in the plan at all', () => {
      // Something else put it there for a reason CloudForge does not know.
      const change = planRuntimeOperations(
        plan({ networks: [edge] }),
        observation({
          containers: [container({ name: 'monitoring-agent' })],
          networks: [network({ containerNames: ['monitoring-agent'] })],
        }),
      );

      expect(change.operations).toEqual([]);
    });
  });

  describe('removal', () => {
    const dropped = observation({
      networks: [network({ name: 'old-net', ownership: 'cloudforge-managed' })],
    });

    it('does not propose removal unless the user asked by name', () => {
      const change = planRuntimeOperations(plan(), dropped, NO_APPLY_OPTIONS);

      expect(change.operations).toEqual([]);
    });

    it('removes an empty owned network the user named', () => {
      const change = planRuntimeOperations(plan(), dropped, { remove: ['old-net'] });

      expect(ids(change)).toEqual(['network.remove:old-net']);
      expect(change.operations[0]?.risk).toBe('destructive');
      expect(destructiveNames(change)).toEqual(['old-net']);
    });

    it('refuses to remove a network with containers on it, even when asked', () => {
      const change = planRuntimeOperations(
        plan(),
        observation({
          networks: [
            network({ name: 'old-net', ownership: 'cloudforge-managed', containerNames: ['a'] }),
          ],
        }),
        { remove: ['old-net'] },
      );

      expect(ids(change)).toEqual(['network.remove.blocked:old-net']);
      expect(change.operations[0]?.kind).toBe('manual');
      expect(destructiveNames(change)).toEqual([]);
    });

    it('never removes a network CloudForge does not own, even when named', () => {
      const change = planRuntimeOperations(
        plan(),
        observation({
          networks: [network({ name: 'old-net', ownership: 'unmanaged', labels: {} })],
        }),
        { remove: ['old-net'] },
      );

      expect(change.operations).toEqual([]);
    });

    it('never removes a network belonging to another target', () => {
      const change = planRuntimeOperations(
        plan(),
        observation({
          networks: [
            network({
              name: 'old-net',
              ownership: 'cloudforge-managed',
              labels: { [RUNTIME_LABELS.managed]: 'true', [RUNTIME_LABELS.targetId]: 'target-2' },
            }),
          ],
        }),
        { remove: ['old-net'] },
      );

      expect(change.operations).toEqual([]);
    });
  });

  describe('things CloudForge will not do itself', () => {
    it('explains that a port change needs a redeploy', () => {
      const change = planRuntimeOperations(
        plan({
          services: [
            service({
              exposure: 'direct',
              ports: [{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }],
            }),
          ],
        }),
        observation({ containers: [container()] }),
      );

      expect(ids(change)).toEqual(['manual.redeploy:app-web']);
      expect(change.operations[0]?.detail).toContain('does not recreate containers');
      expect(change.applyable).toBe(false);
    });

    it('collapses several redeploy reasons for one container into one instruction', () => {
      const change = planRuntimeOperations(
        plan({ services: [service({ image: 'nginx:1.27', restartPolicy: 'always' })] }),
        observation({ containers: [container()] }),
      );

      expect(ids(change)).toEqual(['manual.redeploy:app-web']);
    });

    it('does not count explanations as work worth applying', () => {
      const change = planRuntimeOperations(
        plan({ services: [service({ image: 'other' })] }),
        observation({ containers: [container()] }),
      );

      expect(executableOperations(change)).toEqual([]);
      expect(change.applyable).toBe(false);
    });
  });

  it('is deterministic, so a preview is a promise rather than a guess', () => {
    const p = plan({
      networks: [edge],
      services: [service({ networks: [{ networkName: 'edge', aliases: ['web'] }] })],
    });
    const o = observation({ containers: [container()] });

    expect(planRuntimeOperations(p, o)).toEqual(planRuntimeOperations(p, o));
  });
});

describe('ownershipLabels', () => {
  it('records the target and plan version so ownership is legible from the resource', () => {
    expect(ownershipLabels(plan({ version: 4 }), 'network')).toEqual({
      [RUNTIME_LABELS.managed]: 'true',
      [RUNTIME_LABELS.targetId]: TARGET,
      [RUNTIME_LABELS.planVersion]: '4',
      [RUNTIME_LABELS.resourceKind]: 'network',
    });
  });

  it('never contains a secret, because labels are world-readable to Docker', () => {
    const labels = ownershipLabels(plan(), 'network');

    expect(Object.keys(labels).every((key) => key.startsWith('io.cloudforge.'))).toBe(true);
  });
});
