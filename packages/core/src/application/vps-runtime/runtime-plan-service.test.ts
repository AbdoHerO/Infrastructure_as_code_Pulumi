import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeploymentError,
  ok,
  NotFoundError,
  PersistenceError,
  type Result,
  ValidationError,
} from '@cloudforge/shared';
import type { ActivityService, RecordActivityInput } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type {
  HostFirewallManager,
  HostFirewallPort,
  HostFirewallState,
} from '../ports/host-firewall.js';
import type { RuntimeApplier, RuntimeApplyReport } from '../ports/runtime-applier.js';
import type {
  ObservedNetwork,
  RuntimeInspector,
  RuntimeObservation,
} from '../ports/runtime-inspector.js';
import type { RuntimePlanStore } from '../ports/runtime-plan-store.js';
import type { RuntimeOperation } from './runtime-operations.js';
import { RUNTIME_LABELS } from './runtime-ownership.js';
import { RuntimePlanService } from './runtime-plan-service.js';
import { emptyRuntimePlan, type VpsRuntimePlan } from './vps-runtime-plan.js';

const TARGET = '3f1c2b8e-9a4d-4e5f-8b7a-1c2d3e4f5a6b';
const NOW = new Date('2026-02-02T10:00:00.000Z');

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'deploy',
  privateKey: 'KEY',
  hostKeySha256: 'SHA256:abc',
};

const observation = (overrides: Partial<RuntimeObservation> = {}): RuntimeObservation => ({
  targetId: TARGET,
  observedAt: '2026-02-02T09:00:00.000Z',
  docker: { available: true, version: '27.0.0', composeVersion: 'v2.29.0' },
  containers: [],
  networks: [],
  volumes: [],
  ...overrides,
});

// The mocks are annotated with the port's own return type rather than letting
// it be inferred from the happy path, so a test can inject a failure.
function build() {
  const rows = new Map<string, VpsRuntimePlan>();
  const load = vi.fn((id: string): Promise<Result<VpsRuntimePlan | null, PersistenceError>> =>
    Promise.resolve(ok(rows.get(id) ?? null)),
  );
  const save = vi.fn(
    (id: string, plan: VpsRuntimePlan): Promise<Result<void, PersistenceError>> => {
      rows.set(id, plan);
      return Promise.resolve(ok(undefined));
    },
  );
  const remove = vi.fn((id: string): Promise<Result<void, PersistenceError>> => {
    rows.delete(id);
    return Promise.resolve(ok(undefined));
  });
  const plans: RuntimePlanStore = { load, save, delete: remove };

  const resolve = vi.fn((): Promise<Result<DeploymentTarget, DeploymentError>> =>
    Promise.resolve(ok(target)),
  );
  const targets: RemoteTargetResolver = { resolve };

  const inspect = vi.fn((): Promise<Result<RuntimeObservation, DeploymentError>> =>
    Promise.resolve(ok(observation())),
  );
  const inspector: RuntimeInspector = { inspect };

  const recordSafe = vi.fn((_input: RecordActivityInput): void => undefined);
  const activities = { recordSafe } as unknown as ActivityService;

  const applyImpl = vi.fn(
    (
      _target: DeploymentTarget,
      _plan: VpsRuntimePlan,
      operations: readonly RuntimeOperation[],
    ): Promise<Result<RuntimeApplyReport, DeploymentError>> =>
      Promise.resolve(
        ok({
          outcomes: operations.map((o) => ({
            operationId: o.id,
            status: 'applied' as const,
            message: 'ok',
          })),
          applied: operations.length,
          failed: 0,
        }),
      ),
  );
  const applier: RuntimeApplier = { apply: applyImpl };

  let firewall: HostFirewallState = {
    backend: 'ufw',
    active: true,
    rules: [],
    indeterminate: false,
  };
  const setFirewall = (next: Partial<HostFirewallState>): void => {
    firewall = { ...firewall, ...next };
  };
  const inspectFirewall = vi.fn((): Promise<Result<HostFirewallState, DeploymentError>> =>
    Promise.resolve(ok(firewall)),
  );
  // Typed with their real parameters so a test can assert which ports were sent.
  const openFirewall = vi.fn(
    (
      _target: DeploymentTarget,
      _ports: readonly HostFirewallPort[],
    ): Promise<Result<HostFirewallState, DeploymentError>> => Promise.resolve(ok(firewall)),
  );
  const closeFirewall = vi.fn(
    (
      _target: DeploymentTarget,
      _ports: readonly HostFirewallPort[],
    ): Promise<Result<HostFirewallState, DeploymentError>> => Promise.resolve(ok(firewall)),
  );
  const hostFirewall: HostFirewallManager = {
    inspect: inspectFirewall,
    open: openFirewall,
    close: closeFirewall,
  };

  const service = new RuntimePlanService(
    plans,
    targets,
    inspector,
    activities,
    applier,
    hostFirewall,
  );
  return {
    service,
    rows,
    load,
    save,
    remove,
    resolve,
    inspect,
    recordSafe,
    applyImpl,
    setFirewall,
    inspectFirewall,
    openFirewall,
    closeFirewall,
  };
}

const managed = (overrides: Partial<VpsRuntimePlan> = {}): VpsRuntimePlan => ({
  ...emptyRuntimePlan(TARGET),
  mode: 'managed',
  ...overrides,
});

describe('RuntimePlanService', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  describe('get', () => {
    it('describes a never-managed target as legacy mode with no intent', () => {
      // The guarantee behind every upgrade: a target CloudForge has not been
      // asked to manage must read as "changes nothing", not as an error.
      return ctx.service.get(TARGET).then((result) => {
        expect(result.ok && result.value.plan.mode).toBe('legacy');
        expect(result.ok && result.value.plan.version).toBe(0);
        expect(result.ok && result.value.applyable).toBe(true);
      });
    });

    it('rejects an id that is not a saved target', async () => {
      const result = await ctx.service.get('not-a-uuid');

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ValidationError);
      expect(ctx.load).not.toHaveBeenCalled();
    });

    it('surfaces a persistence failure rather than pretending there is no plan', async () => {
      ctx.load.mockResolvedValueOnce({ ok: false, error: new PersistenceError('disk gone') });

      expect((await ctx.service.get(TARGET)).ok).toBe(false);
    });

    it('returns the stored plan with its issues', async () => {
      await ctx.service.save(TARGET, managed({ reverseProxy: 'none' }), NOW);

      const result = await ctx.service.get(TARGET);

      expect(result.ok && result.value.plan.version).toBe(1);
      expect(result.ok && result.value.issues).toEqual([]);
    });
  });

  describe('save', () => {
    it('stores a valid plan and bumps its version', async () => {
      const result = await ctx.service.save(TARGET, managed(), NOW);

      expect(result.ok && result.value.plan.version).toBe(1);
      expect(ctx.rows.get(TARGET)?.version).toBe(1);
    });

    it('stamps updatedAt and preserves the original createdAt', async () => {
      await ctx.service.save(TARGET, managed({ createdAt: '2020-01-01T00:00:00.000Z' }), NOW);
      const second = await ctx.service.save(
        TARGET,
        managed({ version: 1, createdAt: '2099-01-01T00:00:00.000Z' }),
        NOW,
      );

      expect(second.ok && second.value.plan.createdAt).toBe('2020-01-01T00:00:00.000Z');
      expect(second.ok && second.value.plan.updatedAt).toBe(NOW.toISOString());
    });

    it('ignores a targetId in the payload and uses the one being addressed', async () => {
      // Otherwise a caller could overwrite another target's plan by naming it.
      const result = await ctx.service.save(TARGET, managed({ targetId: 'somewhere-else' }), NOW);

      expect(result.ok && result.value.plan.targetId).toBe(TARGET);
      expect([...ctx.rows.keys()]).toEqual([TARGET]);
    });

    it('refuses to overwrite a plan that changed underneath it', async () => {
      await ctx.service.save(TARGET, managed(), NOW);

      const stale = await ctx.service.save(TARGET, managed({ version: 0 }), NOW);

      expect(stale.ok).toBe(false);
      expect(!stale.ok && stale.error.code).toBe('CONFLICT');
      expect(!stale.ok && stale.error.message).toContain('edited elsewhere');
      expect(ctx.rows.get(TARGET)?.version).toBe(1);
    });

    it('will not store a self-contradictory plan', async () => {
      const result = await ctx.service.save(
        TARGET,
        managed({
          routes: [
            {
              domain: 'example.com',
              path: '/',
              serviceName: 'ghost',
              servicePort: 80,
              websocket: false,
              tls: true,
            },
          ],
        }),
        NOW,
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ValidationError);
      expect(ctx.save).not.toHaveBeenCalled();
    });

    it('reports what is wrong, not just that something is', async () => {
      const result = await ctx.service.save(
        TARGET,
        managed({
          networks: [
            {
              name: 'edge',
              dockerName: 'edge',
              displayName: 'Edge',
              driver: 'bridge',
              scope: 'shared-proxy',
              internal: true,
              attachable: true,
              ipv6: false,
              labels: {},
            },
          ],
        }),
        NOW,
      );

      const issues = !result.ok ? ((result.error.context?.issues ?? []) as { id: string }[]) : [];
      expect(issues.map((i) => i.id)).toContain('network.proxy.internal');
    });

    it('stores a plan that only has warnings', async () => {
      // A plan can be deliberately unusual. Only self-contradiction blocks.
      const result = await ctx.service.save(
        TARGET,
        managed({
          applications: [
            {
              name: 'app',
              displayName: 'App',
              composeProject: 'app',
              sourceMode: 'hybrid-override',
            },
          ],
          services: [
            {
              name: 'web',
              applicationName: 'app',
              kind: 'web',
              containerName: 'app-web',
              exposure: 'direct',
              ports: [{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }],
              networks: [],
              serviceReferences: [],
              volumes: [],
              restartPolicy: 'unless-stopped',
            },
          ],
        }),
        NOW,
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.applyable).toBe(true);
      expect(result.ok && result.value.issues.map((i) => i.id)).toEqual([
        'service.network.none',
        'service.exposure.public',
      ]);
    });

    it('rejects a plan too large to be a topology', async () => {
      const huge = managed({ metadata: { blob: 'x'.repeat(600_000) } });

      const result = await ctx.service.save(TARGET, huge, NOW);

      expect(result.ok).toBe(false);
      expect(ctx.save).not.toHaveBeenCalled();
    });

    it('records the save in Activity without copying the plan into it', async () => {
      await ctx.service.save(TARGET, managed(), NOW);

      expect(ctx.recordSafe.mock.calls[0]?.[0]).toMatchObject({
        type: 'runtime.plan.saved',
        metadata: { targetId: TARGET, version: 1, mode: 'managed' },
      });
    });

    it('does not record Activity for a save that failed', async () => {
      ctx.save.mockResolvedValueOnce({ ok: false, error: new PersistenceError('disk full') });

      const result = await ctx.service.save(TARGET, managed(), NOW);

      expect(result.ok).toBe(false);
      expect(ctx.recordSafe).not.toHaveBeenCalled();
    });

    it('forces the current schema version onto whatever it is handed', async () => {
      const result = await ctx.service.save(TARGET, managed({ schemaVersion: 99 }), NOW);

      expect(result.ok && result.value.plan.schemaVersion).toBe(1);
    });
  });

  describe('setMode', () => {
    it('moves a target from legacy to managed', async () => {
      const result = await ctx.service.setMode(TARGET, 'managed', NOW);

      expect(result.ok && result.value.plan.mode).toBe('managed');
      expect(ctx.recordSafe.mock.calls.at(-1)?.[0]).toMatchObject({
        type: 'runtime.mode.changed',
        metadata: { from: 'legacy', to: 'managed' },
      });
    });

    it('is a no-op when the mode is already set', async () => {
      const result = await ctx.service.setMode(TARGET, 'legacy', NOW);

      expect(result.ok).toBe(true);
      expect(ctx.save).not.toHaveBeenCalled();
      expect(ctx.recordSafe).not.toHaveBeenCalled();
    });
  });

  describe('inspect', () => {
    it('resolves the target itself rather than trusting a caller-supplied host', async () => {
      // The fingerprint is loaded here, from the database. A caller that could
      // name its own host or fingerprint would defeat the pinning entirely.
      await ctx.service.inspect(TARGET);

      expect(ctx.resolve).toHaveBeenCalledWith(TARGET);
      expect(ctx.inspect).toHaveBeenCalledWith(target, TARGET);
    });

    it('rejects an id that is not a saved target', async () => {
      expect((await ctx.service.inspect('nope')).ok).toBe(false);
      expect(ctx.resolve).not.toHaveBeenCalled();
    });
  });

  describe('drift', () => {
    it('compares the stored plan against the live runtime', async () => {
      await ctx.service.save(
        TARGET,
        managed({ volumes: [{ name: 'data', dockerName: 'app-data' }] }),
        NOW,
      );

      const result = await ctx.service.drift(TARGET);

      expect(result.ok && result.value.entries.map((e) => e.id)).toEqual(['volume.missing']);
      expect(result.ok && result.value.planVersion).toBe(1);
    });

    it('reports a legacy target as in sync no matter what is running', async () => {
      const result = await ctx.service.drift(TARGET);

      expect(result.ok && result.value.inSync).toBe(true);
    });

    it('fails loudly when the VPS cannot be reached', async () => {
      ctx.inspect.mockResolvedValueOnce({ ok: false, error: new DeploymentError('unreachable') });

      const result = await ctx.service.drift(TARGET);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(DeploymentError);
    });
  });

  describe('delete', () => {
    it('forgets the plan and says the VPS was untouched', async () => {
      await ctx.service.save(TARGET, managed(), NOW);

      const result = await ctx.service.delete(TARGET);

      expect(result.ok).toBe(true);
      expect(ctx.rows.size).toBe(0);
      const recorded = ctx.recordSafe.mock.calls.at(-1)?.[0];
      expect(recorded?.type).toBe('runtime.plan.deleted');
      expect(recorded?.message).toContain('Nothing running on the VPS was changed');
    });

    it('rejects an id that is not a saved target', async () => {
      expect((await ctx.service.delete('nope')).ok).toBe(false);
      expect(ctx.remove).not.toHaveBeenCalled();
    });
  });

  describe('validate', () => {
    it('checks a plan without touching the database', () => {
      const result = ctx.service.validate(
        managed({ mode: 'legacy', volumes: [{ name: 'x', dockerName: 'x' }] }),
      );

      expect(result.applyable).toBe(true);
      expect(ctx.save).not.toHaveBeenCalled();
      expect(ctx.load).not.toHaveBeenCalled();
    });
  });

  describe('adopt', () => {
    const liveNetwork: ObservedNetwork = {
      id: 'n1',
      name: 'legacy-net',
      driver: 'bridge',
      internal: false,
      attachable: true,
      ipv6: false,
      labels: {},
      ownership: 'unmanaged',
      containerNames: [],
    };

    it('records ownership without touching the VPS', async () => {
      ctx.inspect.mockResolvedValue(ok(observation({ networks: [liveNetwork] })));

      const result = await ctx.service.adopt(TARGET, 'network', 'legacy-net', NOW);

      expect(result.ok && result.value.plan.adoptions).toEqual([
        { dockerName: 'legacy-net', resourceKind: 'network', adoptedAt: NOW.toISOString() },
      ]);
      expect(ctx.applyImpl).not.toHaveBeenCalled();
      const recorded = ctx.recordSafe.mock.calls.at(-1)?.[0];
      expect(recorded?.type).toBe('runtime.adopted');
      expect(recorded?.message).toContain('Nothing on the VPS was changed');
    });

    it('refuses to adopt a name that does not exist', async () => {
      // Otherwise CloudForge would claim authority over whatever later takes
      // that name, which is the silent claim of ownership this design prevents.
      ctx.inspect.mockResolvedValue(ok(observation()));

      const result = await ctx.service.adopt(TARGET, 'network', 'legacy-net', NOW);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(NotFoundError);
      expect(!result.ok && result.error.message).toContain('nothing to adopt');
    });

    it('is idempotent', async () => {
      ctx.inspect.mockResolvedValue(ok(observation({ networks: [liveNetwork] })));
      await ctx.service.adopt(TARGET, 'network', 'legacy-net', NOW);
      ctx.save.mockClear();

      const again = await ctx.service.adopt(TARGET, 'network', 'legacy-net', NOW);

      expect(again.ok && again.value.plan.adoptions).toHaveLength(1);
      expect(ctx.save).not.toHaveBeenCalled();
    });

    it('gives a resource back without touching the VPS', async () => {
      ctx.inspect.mockResolvedValue(ok(observation({ networks: [liveNetwork] })));
      await ctx.service.adopt(TARGET, 'network', 'legacy-net', NOW);

      const result = await ctx.service.release(TARGET, 'network', 'legacy-net', NOW);

      expect(result.ok && result.value.plan.adoptions).toEqual([]);
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });
  });

  describe('preview and apply', () => {
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

    const liveNetwork = (overrides: Partial<ObservedNetwork> = {}): ObservedNetwork => ({
      id: 'n1',
      name: 'edge-net',
      driver: 'bridge',
      internal: false,
      attachable: true,
      ipv6: false,
      labels: { [RUNTIME_LABELS.managed]: 'true', [RUNTIME_LABELS.targetId]: TARGET },
      ownership: 'cloudforge-managed',
      containerNames: [],
      ...overrides,
    });

    const seedPlan = () => ctx.service.save(TARGET, managed({ networks: [edge] }), NOW);
    const tokenOf = (preview: Awaited<ReturnType<typeof ctx.service.preview>>): string =>
      preview.ok ? preview.value.token : '';

    it('previews the work and mints a token for it', async () => {
      await seedPlan();

      const preview = await ctx.service.preview(TARGET);

      expect(preview.ok && preview.value.operations.map((o) => o.id)).toEqual([
        'network.create:edge-net',
      ]);
      expect(preview.ok && preview.value.token).toBeTruthy();
    });

    it('applies exactly the previewed operations', async () => {
      await seedPlan();
      const preview = await ctx.service.preview(TARGET);

      const result = await ctx.service.apply(TARGET, tokenOf(preview));

      expect(result.ok && result.value.applied).toBe(1);
      const sent: readonly RuntimeOperation[] = ctx.applyImpl.mock.calls[0]?.[2] ?? [];
      expect(sent.map((o) => o.id)).toEqual(['network.create:edge-net']);
    });

    it('refuses to apply without a preview', async () => {
      await seedPlan();

      const result = await ctx.service.apply(TARGET, '');

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.message).toContain('Preview this change');
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('refuses a token that was never minted', async () => {
      await seedPlan();
      await ctx.service.preview(TARGET);

      const result = await ctx.service.apply(TARGET, 'a-token-i-made-up');

      expect(result.ok).toBe(false);
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('refuses a token once the VPS has moved on', async () => {
      // The approval described a server that no longer exists. Re-deriving the
      // change from the live VPS rather than replaying the preview catches this.
      await seedPlan();
      const preview = await ctx.service.preview(TARGET);
      ctx.inspect.mockResolvedValue(ok(observation({ networks: [liveNetwork()] })));

      const result = await ctx.service.apply(TARGET, tokenOf(preview));

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.message).toContain('changed since you previewed');
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('spends the token, so one approval cannot authorise two applies', async () => {
      await seedPlan();
      const preview = await ctx.service.preview(TARGET);
      await ctx.service.apply(TARGET, tokenOf(preview));
      ctx.applyImpl.mockClear();

      const again = await ctx.service.apply(TARGET, tokenOf(preview));

      expect(again.ok).toBe(false);
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('refuses to apply around an unresolved ownership conflict', async () => {
      await seedPlan();
      ctx.inspect.mockResolvedValue(
        ok(observation({ networks: [liveNetwork({ ownership: 'unmanaged', labels: {} })] })),
      );
      const preview = await ctx.service.preview(TARGET);

      const result = await ctx.service.apply(TARGET, tokenOf(preview));

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('CONFLICT');
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('requires the exact name of anything being removed', async () => {
      await ctx.service.save(TARGET, managed(), NOW);
      ctx.inspect.mockResolvedValue(
        ok(observation({ networks: [liveNetwork({ name: 'old-net' })] })),
      );
      const options = { remove: ['old-net'] };
      const preview = await ctx.service.preview(TARGET, options);

      const unconfirmed = await ctx.service.apply(TARGET, tokenOf(preview), [], options);
      expect(unconfirmed.ok).toBe(false);
      expect(!unconfirmed.ok && unconfirmed.error.message).toContain('old-net');
      expect(ctx.applyImpl).not.toHaveBeenCalled();

      const confirmed = await ctx.service.apply(TARGET, tokenOf(preview), ['old-net'], options);
      expect(confirmed.ok).toBe(true);
      expect(ctx.applyImpl).toHaveBeenCalledOnce();
    });

    it('rejects a confirmation for the wrong name', async () => {
      await ctx.service.save(TARGET, managed(), NOW);
      ctx.inspect.mockResolvedValue(
        ok(observation({ networks: [liveNetwork({ name: 'old-net' })] })),
      );
      const options = { remove: ['old-net'] };
      const preview = await ctx.service.preview(TARGET, options);

      const result = await ctx.service.apply(TARGET, tokenOf(preview), ['some-other-net'], options);

      expect(result.ok).toBe(false);
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('will not apply in legacy mode', async () => {
      const preview = await ctx.service.preview(TARGET);

      expect(preview.ok && preview.value.applyable).toBe(false);
      const result = await ctx.service.apply(TARGET, tokenOf(preview));

      expect(result.ok).toBe(false);
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('does no work and calls no applier when there is nothing to do', async () => {
      await ctx.service.save(TARGET, managed(), NOW);
      const preview = await ctx.service.preview(TARGET);

      const result = await ctx.service.apply(TARGET, tokenOf(preview));

      expect(result.ok && result.value.applied).toBe(0);
      expect(ctx.applyImpl).not.toHaveBeenCalled();
    });

    it('records the apply in Activity', async () => {
      await seedPlan();
      const preview = await ctx.service.preview(TARGET);
      await ctx.service.apply(TARGET, tokenOf(preview));

      const recorded = ctx.recordSafe.mock.calls.at(-1)?.[0];
      expect(recorded?.type).toBe('runtime.applied');
      expect(recorded?.metadata).toMatchObject({ targetId: TARGET, operations: 1 });
    });
  });

  describe('connectivity', () => {
    const withRoute = () =>
      ctx.service.save(
        TARGET,
        managed({
          applications: [
            {
              name: 'app',
              displayName: 'App',
              composeProject: 'app',
              sourceMode: 'hybrid-override',
            },
          ],
          services: [
            {
              name: 'web',
              applicationName: 'app',
              kind: 'web',
              containerName: 'app-web',
              // Published on loopback: the topology a host-based nginx can
              // actually reach. A `proxy-only` service here would be a route
              // that 502s, and the validator rejects it.
              exposure: 'host-loopback',
              ports: [
                { containerPort: 80, protocol: 'tcp', hostPort: 8080, bindAddress: '127.0.0.1' },
              ],
              networks: [],
              serviceReferences: [],
              volumes: [],
              restartPolicy: 'unless-stopped',
            },
          ],
          routes: [
            {
              domain: 'example.com',
              path: '/',
              serviceName: 'web',
              servicePort: 80,
              websocket: false,
              tls: false,
            },
          ],
        }),
        NOW,
      );

    it('reads the firewall without changing it', async () => {
      await withRoute();

      const result = await ctx.service.connectivity(TARGET);

      expect(result.ok).toBe(true);
      expect(ctx.inspectFirewall).toHaveBeenCalledOnce();
      expect(ctx.openFirewall).not.toHaveBeenCalled();
      expect(ctx.closeFirewall).not.toHaveBeenCalled();
    });

    it('says plainly that the provider rules were not supplied', async () => {
      // Rather than leaving the UI to infer it from a page of `unknown` findings.
      await withRoute();

      const result = await ctx.service.connectivity(TARGET);

      expect(result.ok && result.value.providerUnknown).toBe(true);
      expect(result.ok && result.value.findings[0]?.state).toBe('unknown');
    });

    it('calls a port reachable only when both firewalls allow it', async () => {
      await withRoute();
      ctx.setFirewall({
        rules: [{ port: 80, protocol: 'tcp', managed: false, raw: '80/tcp ALLOW' }],
      });

      const result = await ctx.service.connectivity(TARGET, {
        allowed: new Set(['80/tcp']),
        indeterminate: false,
        permitsEverything: false,
      });

      expect(result.ok && result.value.findings[0]?.state).toBe('reachable');
      expect(result.ok && result.value.providerUnknown).toBe(false);
    });

    it('names the host firewall when it is the one blocking', async () => {
      await withRoute();

      const result = await ctx.service.connectivity(TARGET, {
        allowed: new Set(['80/tcp']),
        indeterminate: false,
        permitsEverything: false,
      });

      expect(result.ok && result.value.findings[0]?.state).toBe('blocked-host');
    });

    it('treats an inactive firewall as filtering nothing', async () => {
      // That is the whole meaning of inactive.
      await withRoute();
      ctx.setFirewall({ active: false, rules: [] });

      const result = await ctx.service.connectivity(TARGET, {
        allowed: new Set(['80/tcp']),
        indeterminate: false,
        permitsEverything: false,
      });

      expect(result.ok && result.value.findings[0]?.state).toBe('reachable');
    });

    it('does not treat an unreadable firewall as filtering nothing', async () => {
      // The difference that stops CloudForge reporting a port as open because it
      // failed to look.
      await withRoute();
      ctx.setFirewall({ active: false, indeterminate: true, rules: [] });

      const result = await ctx.service.connectivity(TARGET, {
        allowed: new Set(['80/tcp']),
        indeterminate: false,
        permitsEverything: false,
      });

      expect(result.ok && result.value.findings[0]?.state).toBe('unknown');
    });

    it('returns the firewall itself, so the UI can show it even when the verdict is unknown', async () => {
      await withRoute();
      ctx.setFirewall({ backend: 'nftables' });

      const result = await ctx.service.connectivity(TARGET);

      expect(result.ok && result.value.host.backend).toBe('nftables');
    });

    it('requires nothing of a legacy target', async () => {
      const result = await ctx.service.connectivity(TARGET);

      expect(result.ok && result.value.requirements).toEqual([]);
      expect(result.ok && result.value.findings).toEqual([]);
    });

    it('surfaces a firewall read failure rather than guessing', async () => {
      await withRoute();
      ctx.inspectFirewall.mockResolvedValueOnce({
        ok: false,
        error: new DeploymentError('unreachable'),
      });

      expect((await ctx.service.connectivity(TARGET)).ok).toBe(false);
    });
  });

  describe('openRequiredPorts', () => {
    const withDirectService = () =>
      ctx.service.save(
        TARGET,
        managed({
          applications: [
            {
              name: 'app',
              displayName: 'App',
              composeProject: 'app',
              sourceMode: 'hybrid-override',
            },
          ],
          services: [
            {
              name: 'game',
              applicationName: 'app',
              kind: 'custom',
              containerName: 'app-game',
              exposure: 'direct',
              ports: [{ containerPort: 25565, protocol: 'tcp', hostPort: 25565 }],
              networks: [],
              serviceReferences: [],
              volumes: [],
              restartPolicy: 'unless-stopped',
            },
          ],
        }),
        NOW,
      );

    it('opens exactly the ports the plan needs', async () => {
      await withDirectService();

      const result = await ctx.service.openRequiredPorts(TARGET);

      expect(result.ok).toBe(true);
      expect(ctx.openFirewall.mock.calls[0]?.[1]).toEqual([{ port: 25565, protocol: 'tcp' }]);
    });

    it('never closes anything', async () => {
      // A port CloudForge did not open is not CloudForge's to close.
      await withDirectService();

      await ctx.service.openRequiredPorts(TARGET);

      expect(ctx.closeFirewall).not.toHaveBeenCalled();
    });

    it('refuses on a legacy target', async () => {
      const result = await ctx.service.openRequiredPorts(TARGET);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('CONFLICT');
      expect(ctx.openFirewall).not.toHaveBeenCalled();
    });

    it('says it changed nothing when the plan needs no ports', async () => {
      await ctx.service.save(TARGET, managed(), NOW);

      const result = await ctx.service.openRequiredPorts(TARGET);

      expect(result.ok).toBe(true);
      const recorded = ctx.recordSafe.mock.calls.at(-1)?.[0];
      expect(recorded?.message).toContain('needs no host firewall ports');
    });

    it('records what it opened, and on which backend', async () => {
      await withDirectService();

      await ctx.service.openRequiredPorts(TARGET);

      const recorded = ctx.recordSafe.mock.calls.at(-1)?.[0];
      expect(recorded?.type).toBe('runtime.firewall.opened');
      expect(recorded?.metadata).toMatchObject({ backend: 'ufw', ports: ['25565/tcp'] });
    });

    it('does not record Activity for a failed open', async () => {
      await withDirectService();
      ctx.recordSafe.mockClear();
      ctx.openFirewall.mockResolvedValueOnce({
        ok: false,
        error: new DeploymentError('permission denied'),
      });

      const result = await ctx.service.openRequiredPorts(TARGET);

      expect(result.ok).toBe(false);
      expect(ctx.recordSafe).not.toHaveBeenCalled();
    });
  });

  describe('without a firewall manager', () => {
    it('reports firewall features as unavailable rather than crashing', async () => {
      const bare = new RuntimePlanService(
        { load: vi.fn(), save: vi.fn(), delete: vi.fn() },
        { resolve: vi.fn() },
        { inspect: vi.fn() },
        { recordSafe: vi.fn() } as unknown as ActivityService,
      );

      expect((await bare.connectivity(TARGET)).ok).toBe(false);
      expect((await bare.openRequiredPorts(TARGET)).ok).toBe(false);
    });
  });
});
