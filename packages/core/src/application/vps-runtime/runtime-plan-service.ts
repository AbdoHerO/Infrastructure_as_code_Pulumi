import {
  ConflictError,
  err,
  isUuid,
  newUuid,
  NotFoundError,
  ok,
  type DeploymentError,
  type PersistenceError,
  type Result,
  ValidationError,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { HostFirewallManager, HostFirewallState } from '../ports/host-firewall.js';
import type { NativeServiceRequirements } from '../ports/native-service-requirements.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type {
  RuntimeApplier,
  RuntimeApplyEventSink,
  RuntimeApplyReport,
} from '../ports/runtime-applier.js';
import type { RuntimeInspector, RuntimeObservation } from '../ports/runtime-inspector.js';
import type { RuntimePlanStore } from '../ports/runtime-plan-store.js';
import type { RuntimeProviderFirewall } from '../ports/runtime-provider-firewall.js';
import type {
  RuntimeApplicationSync,
  RuntimeCertificateSync,
  RuntimeDnsRecordSync,
  RuntimeRouteSync,
  RuntimeTargetCatalog,
  RuntimeTopologySynchronizer,
  RuntimeTopologySyncError,
} from '../ports/runtime-topology-synchronizer.js';
import {
  checkConnectivity,
  firewallRequirements,
  portKey,
  type ConnectivityFinding,
  type FirewallRequirement,
  type FirewallView,
} from './firewall-requirements.js';
import { mergeFirewallRequirements } from './ansible-runtime-requirements.js';
import { detectRuntimeDrift, type RuntimeDriftReport } from './runtime-drift.js';
import {
  destructiveNames,
  executableOperations,
  NO_APPLY_OPTIONS,
  planRuntimeOperations,
  type RuntimeApplyOptions,
  type RuntimePlannedChange,
} from './runtime-operations.js';
import {
  adoptedDockerNames,
  emptyRuntimePlan,
  isApplyable,
  normalizeRuntimePlan,
  RUNTIME_PLAN_SCHEMA_VERSION,
  validateRuntimePlan,
  type RuntimeCertificate,
  type RuntimeAdoption,
  type RuntimeMode,
  type RuntimePlanIssue,
  type VpsRuntimePlan,
} from './vps-runtime-plan.js';

export type RuntimePlanServiceError =
  ValidationError | ConflictError | NotFoundError | PersistenceError | DeploymentError;

/** A planned change plus the token that authorises exactly it. */
export interface RuntimePreview extends RuntimePlannedChange {
  readonly token: string;
}

/** A plan plus what is currently wrong with it. The UI always wants both. */
export interface RuntimePlanView {
  readonly plan: VpsRuntimePlan;
  readonly issues: readonly RuntimePlanIssue[];
  readonly applyable: boolean;
}

/** Whether a plan's ports can actually carry traffic, and what is stopping them. */
export interface RuntimeConnectivityReport {
  readonly targetId: string;
  readonly planVersion: number;
  readonly requirements: readonly FirewallRequirement[];
  /** The VPS's own firewall, reported whole so the UI can show it even when the combined verdict is `unknown`. */
  readonly host: HostFirewallState;
  readonly findings: readonly ConnectivityFinding[];
  /**
   * True when the cloud provider's rules were not supplied, so no port can
   * honestly be called reachable. Said out loud rather than inferred from a page
   * of `unknown` findings.
   */
  readonly providerUnknown: boolean;
}

/**
 * A firewall whose rules were not supplied.
 *
 * Not the same as one that allows nothing, and not the same as one that allows
 * everything. Both of those are answers; this is the absence of one.
 */
const UNKNOWN_FIREWALL: FirewallView = {
  allowed: new Set(),
  indeterminate: true,
  permitsEverything: false,
};

/** Serialised plans are bounded so a corrupt or hostile payload cannot fill the database. */
const MAX_PLAN_BYTES = 512_000;

/**
 * Read and write a VPS target's desired runtime.
 *
 * Every mutation in this service touches the database only. Nothing here
 * connects to a VPS or changes a running server — authoring a plan and applying
 * one are deliberately different acts, so that a plan can be written, reviewed
 * and corrected before anything is at stake. `drift` reaches out over SSH, but
 * only to read.
 */
export class RuntimePlanService implements RuntimeTopologySynchronizer {
  /**
   * Live preview authorisations, keyed by target.
   *
   * In memory on purpose: an approval is a statement about a VPS as it was
   * moments ago, and outliving the process that showed it to the user would make
   * it a claim about a server nobody has looked at.
   */
  private readonly previews = new Map<string, { token: string; fingerprint: string }>();

  constructor(
    private readonly plans: RuntimePlanStore,
    private readonly targets: RemoteTargetResolver,
    private readonly inspector: RuntimeInspector,
    private readonly activities: ActivityService,
    private readonly applier?: RuntimeApplier,
    private readonly hostFirewall?: HostFirewallManager,
    private readonly nativeServices?: NativeServiceRequirements,
    private readonly providerFirewall?: RuntimeProviderFirewall,
    private readonly targetCatalog?: RuntimeTargetCatalog,
  ) {}

  /**
   * Every port this target needs open, from the plan and from what is natively
   * installed on it.
   *
   * One list, because a firewall does not care which half of CloudForge asked for
   * a port. Reporting the plan's ports and the native services' ports separately
   * is how the connectivity screen ends up showing 80 twice, and how "open the
   * required ports" ends up opening a different set than the one it just listed.
   *
   * A native-service lookup that fails is not an error here. It means one source
   * of requirements is unavailable, and the plan's own requirements are still
   * worth reporting — refusing to answer at all would be a worse outcome than an
   * incomplete answer, provided the incompleteness cannot be mistaken for
   * "nothing is required". Nothing here ever claims a port is reachable.
   */
  private async requirementsFor(
    targetId: string,
    plan: VpsRuntimePlan,
    target: DeploymentTarget,
  ): Promise<readonly FirewallRequirement[]> {
    const planned = firewallRequirements(plan);
    if (!this.nativeServices) return planned;
    const native = await this.nativeServices.requirements(target);
    if (!native.ok) {
      this.activities.recordSafe({
        type: 'runtime.firewall.partial',
        message:
          'Could not read the natively installed services, so their ports are missing from this report',
        metadata: { targetId, reason: native.error.message },
      });
      return planned;
    }
    return mergeFirewallRequirements(planned, native.value);
  }

  /**
   * Load a target's plan, or the empty legacy plan if it has never had one.
   *
   * Absence is answered with `legacy` mode rather than an error: a target
   * CloudForge has never managed has no intent recorded, and the honest
   * description of no intent is a plan that changes nothing.
   */
  async get(targetId: string): Promise<Result<RuntimePlanView, RuntimePlanServiceError>> {
    if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));
    const loaded = await this.plans.load(targetId);
    if (!loaded.ok) return loaded;
    return ok(view(loaded.value ? normalizeRuntimePlan(loaded.value) : emptyRuntimePlan(targetId)));
  }

  /** Check a plan without saving it, so the UI can report problems as they are typed. */
  validate(plan: VpsRuntimePlan): RuntimePlanView {
    return view(plan);
  }

  /**
   * Persist a plan, rejecting one that is internally inconsistent.
   *
   * Three things are enforced here rather than trusted from the caller:
   *
   * - **Ownership of the record.** `targetId` is taken from the argument, never
   *   from the payload, so a caller cannot write over another target's plan by
   *   naming it in the body.
   * - **Version.** The caller states the version it edited, and a mismatch is a
   *   conflict rather than a silent overwrite — two windows editing one target
   *   must not quietly discard each other's work.
   * - **Validity.** A plan with errors is never stored. Warnings are, because a
   *   plan can be deliberately unusual; errors mean it is self-contradictory,
   *   and storing it would mean every later preview inherits the contradiction.
   */
  async save(
    targetId: string,
    plan: VpsRuntimePlan,
    now: Date = new Date(),
  ): Promise<Result<RuntimePlanView, RuntimePlanServiceError>> {
    if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));

    const normalizedPlan = normalizeRuntimePlan(plan);
    const size = JSON.stringify(normalizedPlan).length;
    if (size > MAX_PLAN_BYTES)
      return err(new ValidationError(`Runtime plan must be under ${String(MAX_PLAN_BYTES)} bytes`));

    const existing = await this.plans.load(targetId);
    if (!existing.ok) return existing;
    const current = existing.value;
    const currentVersion = current?.version ?? 0;
    if (normalizedPlan.version !== currentVersion)
      return err(
        new ConflictError(
          `This plan was edited elsewhere: you are saving version ${String(normalizedPlan.version)} but the stored plan is version ${String(currentVersion)}. Reload before saving.`,
        ),
      );

    const next: VpsRuntimePlan = {
      ...normalizedPlan,
      schemaVersion: RUNTIME_PLAN_SCHEMA_VERSION,
      targetId,
      version: currentVersion + 1,
      createdAt: current?.createdAt ?? normalizedPlan.createdAt,
      updatedAt: now.toISOString(),
    };

    const issues = validateRuntimePlan(next);
    if (!isApplyable(issues))
      return err(
        new ValidationError(
          `This runtime plan has ${String(issues.filter((i) => i.severity === 'error').length)} problem(s) that must be fixed before it can be saved`,
          { context: { issues } },
        ),
      );

    const saved = await this.plans.save(targetId, next);
    if (!saved.ok) return saved;

    this.activities.recordSafe({
      type: 'runtime.plan.saved',
      message: `Saved runtime plan version ${String(next.version)} (${next.mode} mode)`,
      metadata: {
        targetId,
        version: next.version,
        mode: next.mode,
        networks: next.networks.length,
        services: next.services.length,
        routes: next.routes.length,
      },
    });
    return ok(view(next, issues));
  }

  /**
   * Change how much of a target's runtime CloudForge owns.
   *
   * Its own operation rather than a field on `save`, because this is the switch
   * that decides whether CloudForge may change the server at all. It deserves a
   * distinct Activity entry, and a distinct thing for a user to point at when
   * asking "when did this start being managed?".
   */
  async setMode(
    targetId: string,
    mode: RuntimeMode,
    now: Date = new Date(),
  ): Promise<Result<RuntimePlanView, RuntimePlanServiceError>> {
    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const plan = loaded.value.plan;
    if (plan.mode === mode) return ok(loaded.value);
    const result = await this.save(targetId, { ...plan, mode }, now);
    if (!result.ok) return result;
    this.activities.recordSafe({
      type: 'runtime.mode.changed',
      message: `Runtime mode changed from ${plan.mode} to ${mode}`,
      metadata: { targetId, from: plan.mode, to: mode },
    });
    return result;
  }

  /**
   * Take ownership of a resource that already exists on the VPS.
   *
   * A privileged act, and the only way CloudForge ever gains authority over
   * something it did not create — which is why it is a deliberate call with its
   * own Activity entry rather than a flag on a save.
   *
   * The resource must actually exist. Adopting a name that is not there would
   * record authority over whatever later happens to take that name, which is the
   * silent claim of ownership this whole design exists to prevent.
   *
   * Adoption changes nothing on the VPS: it writes a row in CloudForge's
   * database and no more. Nothing is restarted, relabelled or disconnected.
   */
  async adopt(
    targetId: string,
    resourceKind: RuntimeAdoption['resourceKind'],
    dockerName: string,
    now: Date = new Date(),
  ): Promise<Result<RuntimePlanView, RuntimePlanServiceError>> {
    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const plan = loaded.value.plan;
    if (adoptedDockerNames(plan, resourceKind).has(dockerName)) return ok(loaded.value);

    const observed = await this.inspect(targetId);
    if (!observed.ok) return observed;
    const exists = liveNames(observed.value, resourceKind).has(dockerName);
    if (!exists)
      return err(
        new NotFoundError(
          `No ${resourceKind} named "${dockerName}" exists on this target, so there is nothing to adopt.`,
        ),
      );

    const adoption: RuntimeAdoption = {
      dockerName,
      resourceKind,
      adoptedAt: now.toISOString(),
    };
    const result = await this.save(
      targetId,
      { ...plan, adoptions: [...plan.adoptions, adoption] },
      now,
    );
    if (!result.ok) return result;
    this.activities.recordSafe({
      type: 'runtime.adopted',
      message: `Adopted ${resourceKind} "${dockerName}". Nothing on the VPS was changed.`,
      metadata: { targetId, resourceKind, dockerName },
    });
    return result;
  }

  /**
   * Give a resource back.
   *
   * The reverse of adoption and equally harmless to the VPS: CloudForge stops
   * considering the resource its own and will not touch it again.
   */
  async release(
    targetId: string,
    resourceKind: RuntimeAdoption['resourceKind'],
    dockerName: string,
    now: Date = new Date(),
  ): Promise<Result<RuntimePlanView, RuntimePlanServiceError>> {
    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const plan = loaded.value.plan;
    const remaining = plan.adoptions.filter(
      (a) => !(a.dockerName === dockerName && a.resourceKind === resourceKind),
    );
    if (remaining.length === plan.adoptions.length) return ok(loaded.value);
    const result = await this.save(targetId, { ...plan, adoptions: remaining }, now);
    if (!result.ok) return result;
    this.activities.recordSafe({
      type: 'runtime.released',
      message: `Released ${resourceKind} "${dockerName}". Nothing on the VPS was changed.`,
      metadata: { targetId, resourceKind, dockerName },
    });
    return result;
  }

  /** Read a target's live runtime. Never mutates it. */
  async inspect(targetId: string): Promise<Result<RuntimeObservation, RuntimePlanServiceError>> {
    if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    return this.inspector.inspect(target.value, targetId);
  }

  /** Compare desired against actual. Read-only from end to end. */
  async drift(targetId: string): Promise<Result<RuntimeDriftReport, RuntimePlanServiceError>> {
    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const observed = await this.inspect(targetId);
    if (!observed.ok) return observed;
    return ok(detectRuntimeDrift(loaded.value.plan, observed.value));
  }

  /**
   * Whether this plan's ports can actually carry traffic.
   *
   * Read-only on both sides. A port is reachable only when the VPS's own
   * firewall *and* the cloud provider's rules allow it, and those two were
   * previously edited on different screens with nothing relating them — so
   * "the port is open" was a claim neither screen could actually make.
   *
   * The provider adapter resolves rules through the target's existing project
   * and credential binding. The optional argument remains as a compatibility
   * override for older IPC callers and tests. When neither source can resolve a
   * provider firewall, every verdict is `unknown` rather than `reachable`, and
   * `providerUnknown` says why.
   */
  async connectivity(
    targetId: string,
    provider?: FirewallView,
  ): Promise<Result<RuntimeConnectivityReport, RuntimePlanServiceError>> {
    if (!this.hostFirewall) return err(new ValidationError('Firewall inspection is not available'));
    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    const host = await this.hostFirewall.inspect(target.value);
    if (!host.ok) return host;

    const requirements = await this.requirementsFor(targetId, loaded.value.plan, target.value);
    let effectiveProvider = provider;
    if (!effectiveProvider && this.providerFirewall) {
      const liveProvider = await this.providerFirewall.inspect(targetId);
      if (!liveProvider.ok) return liveProvider;
      effectiveProvider = liveProvider.value ?? undefined;
    }
    return ok({
      targetId,
      planVersion: loaded.value.plan.version,
      requirements,
      host: host.value,
      findings: checkConnectivity(
        requirements,
        toView(host.value),
        effectiveProvider ?? UNKNOWN_FIREWALL,
      ),
      providerUnknown: effectiveProvider === undefined,
    });
  }

  /**
   * Open the ports this plan needs on the VPS's own firewall.
   *
   * Additive and idempotent. There is no counterpart that closes what the plan
   * stopped needing: a VPS's firewall carries rules put there by people and
   * other tools for reasons CloudForge cannot see, and a port it did not open is
   * not its to close. Closing is a deliberate, separate act.
   */
  async openRequiredPorts(
    targetId: string,
  ): Promise<Result<HostFirewallState, RuntimePlanServiceError>> {
    if (!this.hostFirewall) return err(new ValidationError('Firewall management is not available'));
    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const plan = loaded.value.plan;
    if (plan.mode === 'legacy')
      return err(
        new ConflictError(
          'This target is in legacy mode, so CloudForge changes nothing on it. Switch to hybrid or managed first.',
        ),
      );

    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    // The same list `connectivity` reports. Opening a different set than the one
    // just shown to the user is how a screen ends up saying a port is required,
    // being told to open it, and leaving it closed.
    const requirements = await this.requirementsFor(targetId, plan, target.value);
    const result = await this.hostFirewall.open(
      target.value,
      requirements.map((r) => ({ port: r.port, protocol: r.protocol })),
    );
    if (!result.ok) return result;

    this.activities.recordSafe({
      type: 'runtime.firewall.opened',
      message:
        requirements.length === 0
          ? 'This plan needs no host firewall ports; nothing was changed'
          : `Ensured ${String(requirements.length)} port(s) are open on the VPS firewall`,
      metadata: {
        targetId,
        backend: result.value.backend,
        ports: requirements.map((r) => portKey(r.port, r.protocol)),
      },
    });
    return result;
  }

  /**
   * Work out exactly what applying would do, and hand back a token authorising
   * precisely that.
   *
   * Follows `InfrastructureService`: the token is bound to a fingerprint of the
   * plan, the observation and the options, so it authorises *this* change and
   * not merely "an apply". If any of the three moves between preview and apply,
   * the token stops matching and the user previews again. Approving a screen
   * must never authorise work the screen did not describe.
   */
  async preview(
    targetId: string,
    options: RuntimeApplyOptions = NO_APPLY_OPTIONS,
  ): Promise<Result<RuntimePreview, RuntimePlanServiceError>> {
    const change = await this.plannedChange(targetId, options);
    if (!change.ok) return change;
    const token = newUuid();
    this.previews.set(targetId, { token, fingerprint: fingerprintChange(change.value, options) });
    return ok({ ...change.value, token });
  }

  /**
   * Execute a previewed change.
   *
   * Three gates, in order, before anything runs:
   *
   * 1. The token must match a preview of this exact change, re-derived from the
   *    live VPS rather than replayed from the preview. A server that moved on
   *    invalidates the approval.
   * 2. Nothing may be blocked — an unresolved ownership conflict stops the whole
   *    apply rather than being worked around.
   * 3. Every destructive operation must be confirmed by its exact Docker name.
   *    Typing the name is the point: it cannot be done by muscle memory.
   */
  async apply(
    targetId: string,
    previewToken: string,
    confirmations: readonly string[] = [],
    options: RuntimeApplyOptions = NO_APPLY_OPTIONS,
    onEvent?: RuntimeApplyEventSink,
    signal?: AbortSignal,
  ): Promise<Result<RuntimeApplyReport, RuntimePlanServiceError>> {
    if (!this.applier) return err(new ValidationError('Runtime apply is not available'));

    const change = await this.plannedChange(targetId, options);
    if (!change.ok) return change;

    const approved = this.previews.get(targetId);
    if (!previewToken || approved?.token !== previewToken)
      return err(
        new ValidationError(
          'Preview this change before applying it. The preview has expired or was never run.',
        ),
      );
    if (approved.fingerprint !== fingerprintChange(change.value, options))
      return err(
        new ValidationError(
          'The plan or the VPS changed since you previewed. Preview again to see what would happen now.',
        ),
      );

    if (change.value.blockers.length > 0)
      return err(
        new ConflictError(`This change cannot be applied yet: ${change.value.blockers.join(' ')}`, {
          context: { blockers: change.value.blockers },
        }),
      );

    const required = destructiveNames(change.value);
    const given = new Set(confirmations);
    const unconfirmed = required.filter((name) => !given.has(name));
    if (unconfirmed.length > 0)
      return err(
        new ValidationError(
          `Type the exact name of everything being removed to confirm: ${unconfirmed.join(', ')}`,
          { context: { unconfirmed } },
        ),
      );

    const operations = executableOperations(change.value);
    if (operations.length === 0) return ok({ outcomes: [], applied: 0, failed: 0 });

    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;

    const result = await this.applier.apply(
      target.value,
      loaded.value.plan,
      operations,
      onEvent,
      signal,
    );

    // The token is spent either way. A half-applied VPS is a different VPS, and
    // the next apply must be authorised against what is actually there now.
    this.previews.delete(targetId);

    this.activities.recordSafe({
      type: result.ok && result.value.failed === 0 ? 'runtime.applied' : 'runtime.apply.failed',
      message: result.ok
        ? `Applied ${String(result.value.applied)} runtime operation(s)${result.value.failed > 0 ? `, ${String(result.value.failed)} failed` : ''}`
        : `Runtime apply failed: ${result.error.message}`,
      metadata: {
        targetId,
        planVersion: change.value.planVersion,
        operations: operations.length,
        ...(result.ok ? { applied: result.value.applied, failed: result.value.failed } : {}),
      },
    });
    return result;
  }

  async upsertApplication(
    input: RuntimeApplicationSync,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    return this.mutateTopology(input.targetId, (plan) => {
      const source = {
        module: 'jenkins' as const,
        resourceId: input.sourceId,
        ownership: input.ownership,
      };
      const existing = plan.applications.find(
        (application) =>
          application.source?.module === 'jenkins' &&
          application.source.resourceId === input.sourceId,
      );
      const applicationName = existing?.name ?? uniqueSlug(plan, input.name);
      const service = plan.services.find(
        (candidate) =>
          candidate.source?.module === 'jenkins' && candidate.source.resourceId === input.sourceId,
      );
      const serviceName = service?.name ?? uniqueServiceSlug(plan, `${applicationName}-web`);
      const effectivePort = input.hostPort ?? input.applicationPort;
      const nextApplication = {
        name: applicationName,
        displayName: input.displayName,
        composeProject: input.composeProject,
        sourceMode: 'repository-managed' as const,
        source,
        deploymentMode: input.deploymentMode,
        ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
      };
      const nextService = {
        name: serviceName,
        applicationName,
        kind: 'web',
        containerName: service?.containerName ?? `cloudforge-${applicationName}`,
        exposure: input.exposure,
        ports:
          effectivePort === null
            ? []
            : [
                {
                  containerPort: effectivePort,
                  hostPort: effectivePort,
                  bindAddress: input.exposure === 'host-loopback' ? '127.0.0.1' : '0.0.0.0',
                  protocol: 'tcp' as const,
                  purpose: 'Application HTTP endpoint',
                },
              ],
        networks: [],
        serviceReferences: [],
        volumes: [],
        restartPolicy: 'external',
        runtimeKind: 'host' as const,
        source,
      };
      return cleanupTopology({
        ...plan,
        applications: [
          ...plan.applications.filter((item) => item.name !== applicationName),
          nextApplication,
        ],
        services: [...plan.services.filter((item) => item.name !== serviceName), nextService],
        routes: plan.routes.map((route) =>
          effectivePort !== null &&
          isLoopbackHost(route.upstreamHost) &&
          route.servicePort === effectivePort
            ? { ...route, applicationName, serviceName }
            : route,
        ),
      });
    });
  }

  async removeApplication(
    targetId: string,
    sourceId: string,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    return this.mutateTopology(targetId, (plan) => {
      const applications = plan.applications.filter(
        (application) =>
          !(application.source?.module === 'jenkins' && application.source.resourceId === sourceId),
      );
      const removedServices = new Set(
        plan.services
          .filter(
            (service) =>
              service.source?.module === 'jenkins' && service.source.resourceId === sourceId,
          )
          .map((service) => service.name),
      );
      let next: VpsRuntimePlan = {
        ...plan,
        applications,
        services: plan.services.filter((service) => !removedServices.has(service.name)),
      };
      for (const route of next.routes.filter((item) => removedServices.has(item.serviceName))) {
        next = ensureRouteEndpoint(next, route);
      }
      return cleanupTopology(next);
    });
  }

  async replaceRoutes(
    targetId: string,
    routes: readonly RuntimeRouteSync[],
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    return this.mutateTopology(targetId, (plan) => {
      let next: VpsRuntimePlan = {
        ...plan,
        routes: plan.routes.filter((route) => route.source?.module !== 'nginx'),
      };
      for (const route of routes) next = upsertRuntimeRoute(next, route);
      return cleanupTopology(next);
    });
  }

  async upsertRoute(
    targetId: string,
    route: RuntimeRouteSync,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    return this.mutateTopology(targetId, (plan) =>
      cleanupTopology(upsertRuntimeRoute(plan, route)),
    );
  }

  async removeRoute(
    targetId: string,
    sourceId: string,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    return this.mutateTopology(targetId, (plan) =>
      cleanupTopology({
        ...plan,
        routes: plan.routes.filter(
          (route) => !(route.source?.module === 'nginx' && route.source.resourceId === sourceId),
        ),
      }),
    );
  }

  async replaceCertificates(
    targetId: string,
    collectionId: string,
    certificates: readonly RuntimeCertificateSync[],
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    return this.mutateTopology(targetId, (plan) => {
      const observed = new Set(certificates.map((item) => item.domain.toLowerCase()));
      const missing = plan.certificates
        .filter(
          (item) =>
            item.source.module === 'ssl' &&
            (item.collectionId ?? collectionId) === collectionId &&
            !observed.has(item.domain.toLowerCase()),
        )
        .map((item) => ({
          ...item,
          status: 'missing' as const,
          daysRemaining: null,
          observedAt: new Date().toISOString(),
        }));
      return {
        ...plan,
        certificates: [
          ...plan.certificates.filter((item) => item.source.module !== 'ssl'),
          ...plan.certificates.filter(
            (item) =>
              item.source.module === 'ssl' && (item.collectionId ?? collectionId) !== collectionId,
          ),
          ...missing,
          ...certificates.map(toRuntimeCertificate),
        ],
      };
    });
  }

  async upsertCertificate(
    certificate: RuntimeCertificateSync,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    return this.mutateTopology(certificate.targetId, (plan) => ({
      ...plan,
      certificates: [
        ...plan.certificates.filter(
          (item) =>
            !(item.source.module === 'ssl' && item.source.resourceId === certificate.sourceId),
        ),
        toRuntimeCertificate(certificate),
      ],
    }));
  }

  async upsertDnsRecord(
    record: RuntimeDnsRecordSync,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    const targetId =
      record.targetId ?? (await this.targetCatalog?.findTargetIdByAddress(record.content)) ?? null;
    if (!targetId) return ok(undefined);
    return this.mutateTopology(targetId, (plan) => ({
      ...plan,
      dnsRecords: [
        ...plan.dnsRecords.filter(
          (item) =>
            !(item.source.module === 'cloudflare' && item.source.resourceId === record.sourceId),
        ),
        {
          domain: record.domain,
          recordId: record.recordId,
          zoneId: record.zoneId,
          type: record.type,
          content: record.content,
          ttl: record.ttl,
          proxied: record.proxied,
          status: record.status,
          targetId,
          source: {
            module: 'cloudflare',
            resourceId: record.sourceId,
            ownership: record.ownership,
          },
          observedAt: record.observedAt,
        },
      ],
    }));
  }

  async removeDnsRecord(
    sourceId: string,
    targetId?: string,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    const targetIds = targetId ? [targetId] : ((await this.targetCatalog?.targetIds()) ?? []);
    for (const id of targetIds) {
      const removed = await this.mutateTopology(id, (plan) => ({
        ...plan,
        dnsRecords: plan.dnsRecords.filter(
          (record) =>
            !(record.source.module === 'cloudflare' && record.source.resourceId === sourceId),
        ),
      }));
      if (!removed.ok) return removed;
    }
    return ok(undefined);
  }

  async replaceDnsRecords(
    zoneId: string,
    records: readonly RuntimeDnsRecordSync[],
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    const targetIds = (await this.targetCatalog?.targetIds()) ?? [];
    for (const targetId of targetIds) {
      const cleared = await this.mutateTopology(targetId, (plan) => ({
        ...plan,
        dnsRecords: plan.dnsRecords.filter(
          (record) => !(record.source.module === 'cloudflare' && record.zoneId === zoneId),
        ),
      }));
      if (!cleared.ok) return cleared;
    }
    for (const record of records) {
      const synchronized = await this.upsertDnsRecord(record);
      if (!synchronized.ok) return synchronized;
    }
    return ok(undefined);
  }

  /**
   * Re-derive small feature mutations against the latest plan. A conflict is
   * retried, but no stale whole-plan snapshot is ever forced over another edit.
   */
  private async mutateTopology(
    targetId: string,
    mutate: (plan: VpsRuntimePlan) => VpsRuntimePlan,
  ): Promise<Result<void, RuntimeTopologySyncError>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await this.get(targetId);
      if (!loaded.ok) return loaded;
      const saved = await this.save(targetId, mutate(loaded.value.plan));
      if (saved.ok) return ok(undefined);
      if (!(saved.error instanceof ConflictError) || attempt === 2) return saved;
    }
    return err(new ConflictError('Runtime topology changed repeatedly; refresh and try again'));
  }

  /** Preview and apply must derive the change identically, so they share this. */
  private async plannedChange(
    targetId: string,
    options: RuntimeApplyOptions,
  ): Promise<Result<RuntimePlannedChange, RuntimePlanServiceError>> {
    const loaded = await this.get(targetId);
    if (!loaded.ok) return loaded;
    const observed = await this.inspect(targetId);
    if (!observed.ok) return observed;
    return ok(planRuntimeOperations(loaded.value.plan, observed.value, options));
  }

  /**
   * Forget a target's plan.
   *
   * Removes CloudForge's record of intent and nothing else: every container,
   * network and volume on the VPS keeps running exactly as it is. Called when a
   * target is deleted, since `Setting` has no foreign key to `VpsTarget` and an
   * abandoned row would otherwise be silently inherited by the next target that
   * happened to reuse the id.
   */
  async delete(targetId: string): Promise<Result<void, RuntimePlanServiceError>> {
    if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));
    const result = await this.plans.delete(targetId);
    if (!result.ok) return result;
    this.activities.recordSafe({
      type: 'runtime.plan.deleted',
      message: 'Removed the runtime plan. Nothing running on the VPS was changed.',
      metadata: { targetId },
    });
    return ok(undefined);
  }
}

function view(plan: VpsRuntimePlan, precomputed?: readonly RuntimePlanIssue[]): RuntimePlanView {
  const issues = precomputed ?? validateRuntimePlan(plan);
  return { plan, issues, applyable: isApplyable(issues) };
}

/**
 * Turn a host firewall reading into something `checkConnectivity` can use.
 *
 * An inactive firewall permits everything — that is the whole meaning of
 * inactive. An unreadable one permits nothing knowable, which is different, and
 * conflating the two would let CloudForge report a port as reachable because it
 * failed to look.
 */
function toView(state: HostFirewallState): FirewallView {
  return {
    allowed: new Set(state.rules.map((rule) => portKey(rule.port, rule.protocol))),
    indeterminate: state.indeterminate,
    permitsEverything: !state.indeterminate && !state.active,
  };
}

/** The Docker names live on a target right now, for one kind of resource. */
function liveNames(
  observation: RuntimeObservation,
  resourceKind: RuntimeAdoption['resourceKind'],
): ReadonlySet<string> {
  const source =
    resourceKind === 'container'
      ? observation.containers
      : resourceKind === 'network'
        ? observation.networks
        : observation.volumes;
  return new Set(source.map((item) => item.name));
}

/**
 * Identifies a change exactly.
 *
 * Covers the operations, the blockers and the removal consents together: a
 * preview whose operation list is unchanged but whose blockers appeared is not
 * the same change, and neither is one where the user has since agreed to delete
 * something.
 */
function fingerprintChange(change: RuntimePlannedChange, options: RuntimeApplyOptions): string {
  return JSON.stringify({
    planVersion: change.planVersion,
    operations: change.operations,
    blockers: change.blockers,
    remove: [...options.remove].sort(),
  });
}

function runtimeSlug(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return normalized || fallback;
}

function uniqueName(wanted: string, used: ReadonlySet<string>): string {
  if (!used.has(wanted)) return wanted;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${wanted.slice(0, Math.max(1, 62 - String(suffix).length))}-${String(suffix)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${wanted.slice(0, 54)}-${newUuid().slice(0, 8)}`;
}

function uniqueSlug(plan: VpsRuntimePlan, value: string): string {
  return uniqueName(
    runtimeSlug(value, 'application'),
    new Set(plan.applications.map((item) => item.name)),
  );
}

function uniqueServiceSlug(plan: VpsRuntimePlan, value: string): string {
  return uniqueName(runtimeSlug(value, 'service'), new Set(plan.services.map((item) => item.name)));
}

function isLoopbackHost(host: string | undefined): boolean {
  return host === undefined || host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function ensureRouteEndpoint(
  plan: VpsRuntimePlan,
  route: RuntimeRouteSync | VpsRuntimePlan['routes'][number],
): VpsRuntimePlan {
  const upstreamHost = 'upstreamHost' in route ? route.upstreamHost : undefined;
  const upstreamPort = 'upstreamPort' in route ? route.upstreamPort : route.servicePort;
  const matching = plan.services.find(
    (service) =>
      service.runtimeKind === 'host' &&
      service.ports.some(
        (port) =>
          port.hostPort === upstreamPort &&
          (isLoopbackHost(upstreamHost) || port.bindAddress === upstreamHost),
      ),
  );
  if (matching) return plan;

  const domain = route.domain.toLowerCase();
  const applicationName = uniqueSlug(plan, `route-${domain}`);
  const serviceName = uniqueServiceSlug(plan, `${applicationName}-upstream`);
  const source = {
    module: 'nginx' as const,
    resourceId: `endpoint:${domain}:${String(upstreamPort)}`,
    ownership: 'cloudforge-managed' as const,
  };
  return {
    ...plan,
    applications: [
      ...plan.applications,
      {
        name: applicationName,
        displayName: domain,
        composeProject: applicationName,
        sourceMode: 'repository-managed',
        deploymentMode: 'external',
        source,
      },
    ],
    services: [
      ...plan.services,
      {
        name: serviceName,
        applicationName,
        kind: 'web',
        containerName: `external-${serviceName}`,
        exposure: isLoopbackHost(upstreamHost) ? 'host-loopback' : 'direct',
        ports: [
          {
            containerPort: upstreamPort,
            hostPort: upstreamPort,
            bindAddress: isLoopbackHost(upstreamHost) ? '127.0.0.1' : upstreamHost,
            protocol: 'tcp',
            purpose: 'Nginx upstream',
          },
        ],
        networks: [],
        serviceReferences: [],
        volumes: [],
        restartPolicy: 'external',
        runtimeKind: 'host',
        source,
      },
    ],
  };
}

function upsertRuntimeRoute(plan: VpsRuntimePlan, input: RuntimeRouteSync): VpsRuntimePlan {
  const next = ensureRouteEndpoint(plan, input);
  const target =
    next.services.find(
      (service) =>
        service.runtimeKind === 'host' &&
        service.ports.some(
          (port) =>
            port.hostPort === input.upstreamPort &&
            (isLoopbackHost(input.upstreamHost) || port.bindAddress === input.upstreamHost),
        ),
    ) ??
    next.services.find((service) =>
      service.ports.some((port) => port.hostPort === input.upstreamPort),
    );
  if (!target) return next;
  const route = {
    domain: input.domain.toLowerCase(),
    path: input.path,
    applicationName: target.applicationName,
    serviceName: target.name,
    servicePort: input.upstreamPort,
    websocket: input.websocket,
    tls: input.tls,
    httpRedirect: input.httpRedirect,
    upstreamHost: input.upstreamHost,
    source: {
      module: 'nginx' as const,
      resourceId: input.sourceId,
      ownership: input.ownership,
    },
  };
  return {
    ...next,
    routes: [
      ...next.routes.filter(
        (item) => !(item.source?.module === 'nginx' && item.source.resourceId === input.sourceId),
      ),
      route,
    ],
  };
}

function cleanupTopology(plan: VpsRuntimePlan): VpsRuntimePlan {
  const referencedServices = new Set(plan.routes.map((route) => route.serviceName));
  const services = plan.services.filter(
    (service) =>
      service.source?.module !== 'nginx' ||
      !service.source.resourceId.startsWith('endpoint:') ||
      referencedServices.has(service.name),
  );
  const referencedApplications = new Set([
    ...services.map((service) => service.applicationName),
    ...plan.routes.flatMap((route) => route.applicationName ?? []),
  ]);
  return {
    ...plan,
    services,
    applications: plan.applications.filter(
      (application) =>
        application.source?.module !== 'nginx' ||
        !application.source.resourceId.startsWith('endpoint:') ||
        referencedApplications.has(application.name),
    ),
  };
}

function toRuntimeCertificate(input: RuntimeCertificateSync): RuntimeCertificate {
  return {
    domain: input.domain.toLowerCase(),
    collectionId: input.collectionId,
    authority: input.authority,
    status: input.status,
    expiresAt: input.expiresAt,
    daysRemaining: input.daysRemaining,
    httpsEnabled: input.httpsEnabled,
    httpRedirect: input.httpRedirect,
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    source: {
      module: 'ssl',
      resourceId: input.sourceId,
      ownership: input.ownership,
    },
    observedAt: input.observedAt,
  };
}
