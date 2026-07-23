/**
 * Turns "what differs" into "what CloudForge would do about it".
 *
 * Pure and deterministic: the same plan and observation always produce the same
 * operations, which is what lets a preview be a promise rather than a guess. The
 * applier executes exactly this list and nothing else.
 *
 * **What is deliberately not here.** CloudForge does not create, restart or
 * remove containers. Containers belong to Compose and Jenkins, and taking that
 * over would break every existing deployment pipeline on day one. What
 * CloudForge owns is the topology *around* them — networks, attachments and
 * aliases — which is precisely the layer that had no owner before and
 * where every real breakage came from. When a difference can only be fixed by a
 * redeploy, that is reported as `manual` rather than performed.
 */
import { blockingDrift, detectRuntimeDrift, type RuntimeDriftReport } from './runtime-drift.js';
import {
  isOwned,
  RUNTIME_LABELS,
  type RuntimeOwnership,
  type RuntimeResourceKind,
} from './runtime-ownership.js';
import {
  adoptedDockerNames,
  type RuntimeNetwork,
  type VpsRuntimePlan,
} from './vps-runtime-plan.js';
import type { ObservedNetwork, RuntimeObservation } from '../ports/runtime-inspector.js';

export const OPERATION_KINDS = ['create', 'attach', 'detach', 'remove', 'manual'] as const;

/**
 * - `create` — make something that does not exist. Affects nothing running.
 * - `attach` — connect a container to a network. Additive: it gains a route it
 *   did not have, and loses nothing.
 * - `detach` — disconnect a container from a network. Removes a route, so it can
 *   break a live connection.
 * - `remove` — delete a resource. Only ever an empty, owned network.
 * - `manual` — a difference CloudForge will not fix itself, with an explanation
 *   of what will.
 *
 * There is deliberately no `adopt` operation. Adopting a pre-existing resource
 * would mean labelling it, and Docker labels cannot be changed after creation —
 * the only way to relabel a network is to destroy and recreate it, disconnecting
 * everything on it. Adoption is therefore a plan edit, recorded in
 * `VpsRuntimePlan.adoptions`, and touches the VPS not at all.
 */
export type RuntimeOperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_RISKS = ['safe', 'disruptive', 'destructive'] as const;

/**
 * - `safe` — cannot interrupt traffic.
 * - `disruptive` — can break a live connection.
 * - `destructive` — removes something. Requires typing the exact name.
 */
export type RuntimeOperationRisk = (typeof OPERATION_RISKS)[number];

export interface RuntimeOperation {
  readonly id: string;
  readonly kind: RuntimeOperationKind;
  readonly risk: RuntimeOperationRisk;
  readonly resourceKind: RuntimeResourceKind;
  readonly resource: string;
  readonly dockerName: string;
  readonly summary: string;
  readonly detail?: string | undefined;
}

export interface RuntimeApplyOptions {
  /**
   * Docker names the user explicitly agreed to delete.
   *
   * Not derivable from the plan: a resource being absent from a plan says the
   * user stopped describing it, which is not the same as saying delete it.
   */
  readonly remove: readonly string[];
}

export const NO_APPLY_OPTIONS: RuntimeApplyOptions = { remove: [] };

export interface RuntimePlannedChange {
  readonly targetId: string;
  readonly planVersion: number;
  readonly observedAt: string;
  readonly operations: readonly RuntimeOperation[];
  readonly drift: RuntimeDriftReport;
  /** Reasons the whole apply is refused. Empty means it may proceed. */
  readonly blockers: readonly string[];
  readonly applyable: boolean;
}

interface OperationInput {
  readonly id: string;
  readonly kind: RuntimeOperationKind;
  readonly risk: RuntimeOperationRisk;
  readonly resourceKind: RuntimeResourceKind;
  readonly resource: string;
  readonly dockerName: string;
  readonly summary: string;
  readonly detail?: string | undefined;
}

const operation = (input: OperationInput): RuntimeOperation => ({
  id: input.id,
  kind: input.kind,
  risk: input.risk,
  resourceKind: input.resourceKind,
  resource: input.resource,
  dockerName: input.dockerName,
  summary: input.summary,
  ...(input.detail === undefined ? {} : { detail: input.detail }),
});

/**
 * The labels CloudForge stamps on a resource it owns.
 *
 * Ownership has to be legible from the resource itself so that the next
 * inventory — possibly from a different machine, possibly years later — can tell
 * what it may touch without consulting any database.
 */
export function ownershipLabels(
  plan: VpsRuntimePlan,
  resourceKind: RuntimeResourceKind,
  options: { readonly adopted?: boolean } = {},
): Record<string, string> {
  return {
    [RUNTIME_LABELS.managed]: 'true',
    ...(options.adopted === true ? { [RUNTIME_LABELS.adopted]: 'true' } : {}),
    [RUNTIME_LABELS.targetId]: plan.targetId,
    [RUNTIME_LABELS.planVersion]: String(plan.version),
    [RUNTIME_LABELS.resourceKind]: resourceKind,
  };
}

/** Which containers the plan wants on a given Docker network. */
function desiredMembers(plan: VpsRuntimePlan, network: RuntimeNetwork): Map<string, string[]> {
  const members = new Map<string, string[]>();
  for (const service of plan.services) {
    if ((service.runtimeKind ?? 'container') === 'host') continue;
    const attachment = service.networks.find((n) => n.networkName === network.name);
    if (attachment) members.set(service.containerName, [...attachment.aliases]);
  }
  return members;
}

function networkOperations(
  plan: VpsRuntimePlan,
  observation: RuntimeObservation,
): RuntimeOperation[] {
  const operations: RuntimeOperation[] = [];
  const observed = new Map(observation.networks.map((n) => [n.name, n]));
  const adopted = adoptedDockerNames(plan, 'network');

  for (const network of plan.networks) {
    const live = observed.get(network.dockerName);
    if (!live) {
      operations.push(
        operation({
          id: `network.create:${network.dockerName}`,
          kind: 'create',
          risk: 'safe',
          resourceKind: 'network',
          resource: network.name,
          dockerName: network.dockerName,
          summary: `Create network "${network.dockerName}"`,
          detail: `${network.driver}${network.internal ? ', internal' : ''}${network.attachable ? ', attachable' : ''}`,
        }),
      );
      continue;
    }
    // Not ours and not adopted: leave it alone entirely. `blockers` explains why
    // the apply is refused rather than quietly working around it.
    if (!isOwned(live.ownership) && !adopted.has(network.dockerName)) continue;

    // Docker cannot change a network's driver or internal flag in place, and
    // recreating one means detaching every container on it. That is a decision
    // for a person with the full picture, not something to slip into an apply.
    if (live.driver !== network.driver || live.internal !== network.internal)
      operations.push(
        operation({
          id: `network.recreate:${network.dockerName}`,
          kind: 'manual',
          risk: 'safe',
          resourceKind: 'network',
          resource: network.name,
          dockerName: network.dockerName,
          summary: `Network "${network.dockerName}" cannot be changed in place`,
          detail: `It is ${live.driver}${live.internal ? ', internal' : ''} and the plan describes ${network.driver}${network.internal ? ', internal' : ''}. Docker cannot alter either after creation, so applying this needs the network recreated and every container on it reattached. CloudForge will not do that automatically.`,
        }),
      );
  }
  return operations;
}

function attachmentOperations(
  plan: VpsRuntimePlan,
  observation: RuntimeObservation,
): RuntimeOperation[] {
  const operations: RuntimeOperation[] = [];
  const containers = new Map(observation.containers.map((c) => [c.name, c]));

  for (const network of plan.networks) {
    const wanted = desiredMembers(plan, network);
    for (const [containerName, aliases] of wanted) {
      const container = containers.get(containerName);
      // Nothing to attach to yet: the container arrives with its deployment.
      if (!container) continue;
      const attachment = container.networks.find((n) => n.network === network.dockerName);
      if (!attachment) {
        operations.push(
          operation({
            id: `container.attach:${containerName}:${network.dockerName}`,
            kind: 'attach',
            risk: 'safe',
            resourceKind: 'container',
            resource: containerName,
            dockerName: containerName,
            summary: `Attach "${containerName}" to "${network.dockerName}"`,
            detail:
              aliases.length > 0
                ? `Answering to ${aliases.join(', ')}. Attaching adds a route and removes none, so nothing currently working stops.`
                : 'Attaching adds a route and removes none, so nothing currently working stops.',
          }),
        );
        continue;
      }
      const missing = aliases.filter((alias) => !attachment.aliases.includes(alias));
      // Docker sets aliases at connect time, so a new one means disconnect and
      // reconnect: brief, but a real interruption for anything mid-request.
      if (missing.length > 0)
        operations.push(
          operation({
            id: `container.alias:${containerName}:${network.dockerName}`,
            kind: 'attach',
            risk: 'disruptive',
            resourceKind: 'container',
            resource: containerName,
            dockerName: containerName,
            summary: `Add alias ${missing.join(', ')} to "${containerName}" on "${network.dockerName}"`,
            detail:
              'Docker only sets aliases when a container joins a network, so this reconnects it. Existing connections through this network drop for a moment.',
          }),
        );
    }

    // Detaching is the one routine operation that can break something that is
    // working right now, so it is only ever proposed for a container CloudForge
    // owns outright and only when the plan is explicit about the topology.
    const live = observation.networks.find((n) => n.name === network.dockerName);
    if (!live || !isOwnedForTarget(plan, 'network', live)) continue;
    for (const containerName of live.containerNames) {
      if (wanted.has(containerName)) continue;
      const container = containers.get(containerName);
      if (!container || !isOwnedForTarget(plan, 'container', container)) continue;
      const service = plan.services.find((s) => s.containerName === containerName);
      if (!service) continue; // not in the plan at all: leave it alone
      operations.push(
        operation({
          id: `container.detach:${containerName}:${network.dockerName}`,
          kind: 'detach',
          risk: 'disruptive',
          resourceKind: 'container',
          resource: containerName,
          dockerName: containerName,
          summary: `Detach "${containerName}" from "${network.dockerName}"`,
          detail:
            'The plan no longer puts this service on this network. Anything reaching it through this network stops being able to.',
        }),
      );
    }
  }
  return operations;
}

/**
 * Whether CloudForge may change this resource on this target's behalf.
 *
 * Adoptions are consulted as well as labels, because a resource adopted from a
 * previous life still reports as unmanaged on the wire — Docker labels cannot be
 * added after creation.
 */
function isOwnedForTarget(
  plan: VpsRuntimePlan,
  resourceKind: RuntimeResourceKind,
  resource: {
    readonly name: string;
    readonly ownership: RuntimeOwnership;
    readonly labels: Readonly<Record<string, string>>;
  },
): boolean {
  if (adoptedDockerNames(plan, resourceKind).has(resource.name)) return true;
  return isOwned(resource.ownership) && resource.labels[RUNTIME_LABELS.targetId] === plan.targetId;
}

function removalOperations(
  plan: VpsRuntimePlan,
  observation: RuntimeObservation,
  options: RuntimeApplyOptions,
): RuntimeOperation[] {
  const operations: RuntimeOperation[] = [];
  const planned = new Set(plan.networks.map((n) => n.dockerName));
  const remove = new Set(options.remove);

  for (const network of observation.networks) {
    if (planned.has(network.name)) continue;
    if (!isOwnedForTarget(plan, 'network', network)) continue;
    if (!remove.has(network.name)) continue;
    // A network with containers on it is never removed, even when asked: Docker
    // would refuse anyway, and proposing it would imply CloudForge might detach
    // them first.
    if (network.containerNames.length > 0) {
      operations.push(
        operation({
          id: `network.remove.blocked:${network.name}`,
          kind: 'manual',
          risk: 'safe',
          resourceKind: 'network',
          resource: network.name,
          dockerName: network.name,
          summary: `Cannot remove network "${network.name}" while containers are attached`,
          detail: `Still attached: ${network.containerNames.join(', ')}. Detach or redeploy them first.`,
        }),
      );
      continue;
    }
    operations.push(
      operation({
        id: `network.remove:${network.name}`,
        kind: 'remove',
        risk: 'destructive',
        resourceKind: 'network',
        resource: network.name,
        dockerName: network.name,
        summary: `Remove network "${network.name}"`,
        detail: 'It is empty and the plan no longer describes it.',
      }),
    );
  }
  return operations;
}

/**
 * Differences CloudForge reports but will not act on.
 *
 * A published port, an image or a restart policy is baked into the container at
 * creation. Changing any of them means recreating it — which is the deployment
 * pipeline's job. Saying so plainly is more useful than silently leaving the
 * difference in the drift report and hoping someone reads it.
 */
function manualOperations(drift: RuntimeDriftReport): RuntimeOperation[] {
  const REDEPLOY: Record<string, string> = {
    'container.port.missing': 'the published ports are set when the container is created',
    'container.port.modified': 'the published ports are set when the container is created',
    'container.port.unexpected': 'the published ports are set when the container is created',
    'container.image.modified': 'the image is set when the container is created',
    'container.restartPolicy.modified': 'the restart policy is set when the container is created',
    'container.missing': 'the container does not exist yet',
  };
  const operations: RuntimeOperation[] = [];
  const seen = new Set<string>();
  for (const item of drift.entries) {
    const reason = REDEPLOY[item.id];
    if (reason === undefined) continue;
    const id = `manual.redeploy:${item.dockerName}`;
    if (seen.has(id)) continue;
    seen.add(id);
    operations.push(
      operation({
        id,
        kind: 'manual',
        risk: 'safe',
        // Every id accepted by REDEPLOY above is a container drift. Certificate
        // and DNS drift are observational and never become Docker operations.
        resourceKind: 'container',
        resource: item.resource,
        dockerName: item.dockerName,
        summary: `"${item.dockerName}" needs a redeploy to match the plan`,
        detail: `${item.message}. CloudForge does not recreate containers — ${reason}, so deploy it through its usual pipeline.`,
      }),
    );
  }
  return operations;
}

/**
 * Work out what applying a plan would do, without doing any of it.
 *
 * Adoption and removal are opt-in by exact Docker name: a resource CloudForge
 * does not own is left alone unless the user named it, and nothing is deleted
 * unless the user named it. Neither can be inferred from the plan, because
 * neither is a statement about topology — they are statements about consent.
 */
export function planRuntimeOperations(
  plan: VpsRuntimePlan,
  observation: RuntimeObservation,
  options: RuntimeApplyOptions = NO_APPLY_OPTIONS,
): RuntimePlannedChange {
  const drift = detectRuntimeDrift(plan, observation);
  const blockers: string[] = [];

  if (plan.mode === 'legacy')
    return {
      targetId: plan.targetId,
      planVersion: plan.version,
      observedAt: observation.observedAt,
      operations: [],
      drift,
      blockers: [
        'This target is in legacy mode, so CloudForge changes nothing on it. Switch to hybrid or managed to apply a plan.',
      ],
      applyable: false,
    };

  if (!observation.docker.available)
    return {
      targetId: plan.targetId,
      planVersion: plan.version,
      observedAt: observation.observedAt,
      operations: [],
      drift,
      blockers: ['Docker is not available on this target.'],
      applyable: false,
    };

  // Drift already accounts for adoptions, so anything still blocking here is
  // genuinely unresolved.
  for (const item of blockingDrift(drift)) blockers.push(item.message);

  const operations = [
    ...networkOperations(plan, observation),
    ...attachmentOperations(plan, observation),
    ...removalOperations(plan, observation, options),
    ...manualOperations(drift),
  ];

  return {
    targetId: plan.targetId,
    planVersion: plan.version,
    observedAt: observation.observedAt,
    operations,
    drift,
    blockers,
    applyable: blockers.length === 0 && operations.some((op) => op.kind !== 'manual'),
  };
}

/** Operations that actually run. `manual` ones are explanations, not work. */
export function executableOperations(change: RuntimePlannedChange): readonly RuntimeOperation[] {
  return change.operations.filter((op) => op.kind !== 'manual');
}

/** True when applying this change could interrupt something that is working. */
export function hasDisruptiveOperations(change: RuntimePlannedChange): boolean {
  return executableOperations(change).some((op) => op.risk !== 'safe');
}

/**
 * Names the user must type to confirm.
 *
 * Only destructive operations qualify. Asking for exact-name confirmation on
 * everything would train people to type without reading, which is worse than
 * not asking.
 */
export function destructiveNames(change: RuntimePlannedChange): readonly string[] {
  return [
    ...new Set(
      change.operations.filter((op) => op.risk === 'destructive').map((op) => op.dockerName),
    ),
  ];
}

/** Networks the plan describes, indexed by Docker name — for the applier. */
export function networksByDockerName(plan: VpsRuntimePlan): ReadonlyMap<string, RuntimeNetwork> {
  return new Map(plan.networks.map((network) => [network.dockerName, network]));
}

export type { ObservedNetwork };
