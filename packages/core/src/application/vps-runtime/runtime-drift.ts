/**
 * Compares a target's desired runtime against what is actually running.
 *
 * Read-only and pure: a plan and an observation in, a report out. Nothing here
 * decides what to *do* about a difference — that is the preview/apply engine's
 * job. Keeping detection separate means it can be run against a production
 * server at any time, and tested without one.
 *
 * The rule that shapes everything below: **a resource CloudForge does not own is
 * never drift.** A VPS is full of containers, networks and volumes that predate
 * CloudForge or belong to someone else. Reporting those as "unexpected" would be
 * both useless noise and an invitation to delete a user's work. Only a resource
 * that explicitly carries this target's ownership labels can be missing from the
 * plan; everything else is either adoptable, a name conflict, or simply ignored.
 */
import type {
  ObservedContainer,
  ObservedNetwork,
  ObservedVolume,
  RuntimeObservation,
} from '../ports/runtime-inspector.js';
import {
  isPubliclyReachable,
  RUNTIME_LABELS,
  type RuntimeOwnership,
  type RuntimeResourceKind,
} from './runtime-ownership.js';
import {
  adoptedDockerNames,
  type RuntimeService,
  type VpsRuntimePlan,
} from './vps-runtime-plan.js';

/**
 * A resource's ownership as CloudForge sees it, adoptions included.
 *
 * The inspector can only read labels, and labels cannot be added to an existing
 * resource — so an adopted network still reports as `unmanaged` on the wire.
 * Everything that reasons about authority must go through here rather than
 * trusting the observation directly.
 */
function effectiveOwnership(
  plan: VpsRuntimePlan,
  resourceKind: RuntimeResourceKind,
  dockerName: string,
  observed: RuntimeOwnership,
): RuntimeOwnership {
  if (observed === 'cloudforge-managed' || observed === 'adopted') return observed;
  return adoptedDockerNames(plan, resourceKind).has(dockerName) ? 'adopted' : observed;
}

export const DRIFT_KINDS = [
  'missing',
  'unexpected',
  'modified',
  'ownership-conflict',
  'adoptable',
] as const;

/**
 * What kind of difference this is.
 *
 * - `missing` — the plan describes it, the VPS does not have it.
 * - `unexpected` — CloudForge created it for this target, the plan no longer
 *   describes it. Never removed automatically; removal is a privileged action.
 * - `modified` — it exists, but not as described.
 * - `ownership-conflict` — the name the plan wants is taken by something
 *   CloudForge does not own. Applying would hijack it, so it must block.
 * - `adoptable` — it exists and was evidently made by an older CloudForge, but
 *   ownership has not been claimed. Requires an explicit adoption.
 */
export type RuntimeDriftKind = (typeof DRIFT_KINDS)[number];

export const DRIFT_SEVERITIES = ['info', 'warning', 'error'] as const;

/**
 * How much the difference matters if left alone.
 *
 * - `error` — something is broken or would break: a name collision that blocks
 *   apply, a DNS alias missing so two services cannot talk, a port open to the
 *   internet the plan says should be internal.
 * - `warning` — a real difference the user should decide about.
 * - `info` — worth showing, harmless.
 *
 * Severity describes the *finding*, not whether apply may proceed. A report is
 * never a decision.
 */
export type DriftSeverity = (typeof DRIFT_SEVERITIES)[number];

export interface RuntimeDriftEntry {
  /** Stable rule id, e.g. `service.port.unexpected`. Safe to match on in tests and UI. */
  readonly id: string;
  readonly kind: RuntimeDriftKind;
  readonly severity: DriftSeverity;
  readonly resourceKind: RuntimeResourceKind | 'certificate' | 'dns';
  /** Logical name when the plan knows it, otherwise the Docker name. */
  readonly resource: string;
  readonly dockerName: string;
  readonly ownership: RuntimeOwnership;
  readonly message: string;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
}

export interface RuntimeDriftReport {
  readonly targetId: string;
  readonly planVersion: number;
  readonly observedAt: string;
  /** True when nothing at all differs. */
  readonly inSync: boolean;
  readonly counts: Readonly<Record<DriftSeverity, number>>;
  readonly entries: readonly RuntimeDriftEntry[];
}

interface EntryInput {
  readonly id: string;
  readonly kind: RuntimeDriftKind;
  readonly severity: DriftSeverity;
  readonly resourceKind: RuntimeResourceKind | 'certificate' | 'dns';
  readonly resource: string;
  readonly dockerName: string;
  readonly ownership: RuntimeOwnership;
  readonly message: string;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
}

const entry = (input: EntryInput): RuntimeDriftEntry => ({
  id: input.id,
  kind: input.kind,
  severity: input.severity,
  resourceKind: input.resourceKind,
  resource: input.resource,
  dockerName: input.dockerName,
  ownership: input.ownership,
  message: input.message,
  ...(input.expected === undefined ? {} : { expected: input.expected }),
  ...(input.actual === undefined ? {} : { actual: input.actual }),
});

/**
 * True only when a resource explicitly says it belongs to this target.
 *
 * Deliberately strict. This gates the `unexpected` verdict — the one that leads a
 * user toward deleting something — so an unlabelled resource must never qualify,
 * even if it looks like ours.
 */
function belongsToTarget(labels: Readonly<Record<string, string>>, targetId: string): boolean {
  return labels[RUNTIME_LABELS.targetId] === targetId;
}

function isOwnedByTarget(
  plan: VpsRuntimePlan,
  resourceKind: RuntimeResourceKind,
  resource: {
    readonly name: string;
    readonly ownership: RuntimeOwnership;
    readonly labels: Readonly<Record<string, string>>;
  },
): boolean {
  const effective = effectiveOwnership(plan, resourceKind, resource.name, resource.ownership);
  if (effective !== 'cloudforge-managed' && effective !== 'adopted') return false;
  // A plan-recorded adoption belongs to this target by definition: the plan is
  // this target's. Only label-derived ownership has to prove which target it is.
  if (adoptedDockerNames(plan, resourceKind).has(resource.name)) return true;
  return belongsToTarget(resource.labels, plan.targetId);
}

/**
 * Report that a name the plan wants is already taken by something else.
 *
 * `legacy-managed` and `unmanaged` are treated differently on purpose.
 * A legacy resource carries positive evidence CloudForge made it, so offering
 * adoption is reasonable. An unmanaged one carries no such evidence, and
 * assuming it is "probably the same thing" is exactly the silent claim of
 * ownership that must never happen — so it is an error the user resolves.
 */
function ownershipEntry(
  resourceKind: RuntimeResourceKind,
  resource: string,
  dockerName: string,
  ownership: RuntimeOwnership,
): RuntimeDriftEntry | null {
  if (ownership === 'legacy-managed')
    return entry({
      id: `${resourceKind}.adoptable`,
      kind: 'adoptable',
      severity: 'warning',
      resourceKind,
      resource,
      dockerName,
      ownership,
      message: `"${dockerName}" was created by an earlier CloudForge release and is not yet owned. Adopt it before applying, or it will be left untouched.`,
    });
  if (ownership === 'unmanaged')
    return entry({
      id: `${resourceKind}.ownership-conflict`,
      kind: 'ownership-conflict',
      severity: 'error',
      resourceKind,
      resource,
      dockerName,
      ownership,
      message: `"${dockerName}" already exists and was not created by CloudForge. Applying would take over a resource that is not ours: adopt it explicitly or choose another name.`,
    });
  return null;
}

/** Every host port a container is actually publishing, keyed the way the plan keys them. */
function observedPortKeys(container: ObservedContainer): Map<string, string> {
  const keys = new Map<string, string>();
  for (const port of container.ports) {
    if (port.hostPort === null) continue;
    keys.set(
      `${String(port.containerPort)}/${port.protocol}`,
      `${port.bindAddress ?? '0.0.0.0'}:${String(port.hostPort)}`,
    );
  }
  return keys;
}

function comparePorts(
  service: RuntimeService,
  container: ObservedContainer,
  ownership: RuntimeOwnership,
  ownedByUs: boolean,
): RuntimeDriftEntry[] {
  const issues: RuntimeDriftEntry[] = [];
  const publishes = service.exposure === 'direct' || service.exposure === 'host-loopback';
  const observed = observedPortKeys(container);
  const desired = new Map<string, string>();

  for (const port of service.ports) {
    const key = `${String(port.containerPort)}/${port.protocol}`;
    if (!publishes || port.hostPort === undefined) continue;
    const want = `${port.bindAddress ?? '0.0.0.0'}:${String(port.hostPort)}`;
    desired.set(key, want);
    const actual = observed.get(key);
    if (actual === undefined) {
      issues.push(
        entry({
          id: 'container.port.missing',
          kind: 'missing',
          severity: 'warning',
          resourceKind: 'container',
          resource: service.name,
          dockerName: service.containerName,
          ownership,
          message: `Port ${key} should be published on ${want} but is not published at all`,
          expected: want,
        }),
      );
      continue;
    }
    if (actual !== want)
      issues.push(
        entry({
          id: 'container.port.modified',
          kind: 'modified',
          severity: 'warning',
          resourceKind: 'container',
          resource: service.name,
          dockerName: service.containerName,
          ownership,
          message: `Port ${key} is published on ${actual}, not ${want}`,
          expected: want,
          actual,
        }),
      );
  }

  // A port the plan does not ask for. When it reaches the internet this is the
  // single most valuable thing this whole detector finds — a database the plan
  // calls internal, answering on every interface — so it is an error regardless
  // of who owns the container.
  for (const port of container.ports) {
    const key = `${String(port.containerPort)}/${port.protocol}`;
    if (port.hostPort === null || desired.has(key)) continue;
    const actual = `${port.bindAddress ?? '0.0.0.0'}:${String(port.hostPort)}`;
    const public_ = isPubliclyReachable(port.exposure, port.bindAddress);
    if (!public_ && !ownedByUs) continue;
    issues.push(
      entry({
        id: 'container.port.unexpected',
        kind: 'unexpected',
        severity: public_ ? 'error' : 'info',
        resourceKind: 'container',
        resource: service.name,
        dockerName: service.containerName,
        ownership,
        message: public_
          ? `Port ${key} is published on ${actual} and reachable from outside the VPS, but the plan declares this service "${service.exposure}"`
          : `Port ${key} is published on ${actual}, which the plan does not describe`,
        actual,
      }),
    );
  }
  return issues;
}

function compareNetworks(
  plan: VpsRuntimePlan,
  service: RuntimeService,
  container: ObservedContainer,
  ownership: RuntimeOwnership,
  ownedByUs: boolean,
): RuntimeDriftEntry[] {
  const issues: RuntimeDriftEntry[] = [];
  const dockerNameOf = new Map(plan.networks.map((network) => [network.name, network.dockerName]));
  const attached = new Map(
    container.networks.map((attachment) => [attachment.network, attachment]),
  );
  const desired = new Set<string>();

  for (const wanted of service.networks) {
    const dockerName = dockerNameOf.get(wanted.networkName);
    // An unknown network is a plan error, not drift; validateRuntimePlan owns it.
    if (dockerName === undefined) continue;
    desired.add(dockerName);
    const attachment = attached.get(dockerName);
    if (!attachment) {
      issues.push(
        entry({
          id: 'container.network.missing',
          kind: 'missing',
          severity: 'warning',
          resourceKind: 'container',
          resource: service.name,
          dockerName: service.containerName,
          ownership,
          message: `Not attached to network "${dockerName}"`,
          expected: dockerName,
        }),
      );
      continue;
    }
    // A missing alias is not cosmetic: it is the name other services resolve, so
    // its absence is a connection failure waiting for the next deployment.
    for (const alias of wanted.aliases) {
      if (!attachment.aliases.includes(alias))
        issues.push(
          entry({
            id: 'container.alias.missing',
            kind: 'missing',
            severity: 'error',
            resourceKind: 'container',
            resource: service.name,
            dockerName: service.containerName,
            ownership,
            message: `Does not answer to "${alias}" on network "${dockerName}", so services addressing it by that name cannot reach it`,
            expected: alias,
            actual: attachment.aliases.join(', '),
          }),
        );
    }
  }

  // Extra attachments are only drift for a container CloudForge owns outright.
  // In hybrid mode the repository's own Compose file legitimately puts services
  // on networks CloudForge never declared, and calling that drift would make the
  // report useless for every real migration.
  if (!ownedByUs) return issues;
  const application = plan.applications.find((app) => app.name === service.applicationName);
  if (application?.sourceMode !== 'cloudforge-managed') return issues;
  for (const attachment of container.networks) {
    if (desired.has(attachment.network)) continue;
    issues.push(
      entry({
        id: 'container.network.unexpected',
        kind: 'unexpected',
        severity: 'info',
        resourceKind: 'container',
        resource: service.name,
        dockerName: service.containerName,
        ownership,
        message: `Attached to network "${attachment.network}", which the plan does not describe`,
        actual: attachment.network,
      }),
    );
  }
  return issues;
}

function compareService(
  plan: VpsRuntimePlan,
  service: RuntimeService,
  containers: ReadonlyMap<string, ObservedContainer>,
): RuntimeDriftEntry[] {
  // Host endpoints are observed by Jenkins/Nginx and synchronized into the
  // plan. They deliberately have no Docker container to compare.
  if ((service.runtimeKind ?? 'container') === 'host') return [];
  const container = containers.get(service.containerName);
  if (!container)
    return [
      entry({
        id: 'container.missing',
        kind: 'missing',
        severity: 'warning',
        resourceKind: 'container',
        resource: service.name,
        dockerName: service.containerName,
        ownership: 'unmanaged',
        message: `Container "${service.containerName}" does not exist`,
        expected: service.containerName,
      }),
    ];

  const issues: RuntimeDriftEntry[] = [];
  const ownership = effectiveOwnership(plan, 'container', container.name, container.ownership);
  const ownedByUs = isOwnedByTarget(plan, 'container', container);
  const conflict = ownershipEntry('container', service.name, service.containerName, ownership);
  if (conflict) issues.push(conflict);

  // Comparison continues even when ownership is unresolved: a user deciding
  // whether to adopt needs to see what adopting would change.
  issues.push(...compareNetworks(plan, service, container, ownership, ownedByUs));
  issues.push(...comparePorts(service, container, ownership, ownedByUs));

  if (service.image !== undefined && service.image !== container.image)
    issues.push(
      entry({
        id: 'container.image.modified',
        kind: 'modified',
        severity: 'info',
        resourceKind: 'container',
        resource: service.name,
        dockerName: service.containerName,
        ownership,
        message: `Running "${container.image}", the plan describes "${service.image}"`,
        expected: service.image,
        actual: container.image,
      }),
    );

  if (service.restartPolicy !== container.restartPolicy)
    issues.push(
      entry({
        id: 'container.restartPolicy.modified',
        kind: 'modified',
        severity: 'info',
        resourceKind: 'container',
        resource: service.name,
        dockerName: service.containerName,
        ownership,
        message: `Restart policy is "${container.restartPolicy}", the plan describes "${service.restartPolicy}"`,
        expected: service.restartPolicy,
        actual: container.restartPolicy,
      }),
    );

  const deployedVersion = container.labels[RUNTIME_LABELS.planVersion];
  if (deployedVersion !== undefined && deployedVersion !== String(plan.version))
    issues.push(
      entry({
        id: 'container.planVersion.stale',
        kind: 'modified',
        severity: 'info',
        resourceKind: 'container',
        resource: service.name,
        dockerName: service.containerName,
        ownership,
        message: `Deployed from plan version ${deployedVersion}; the current plan is version ${String(plan.version)}`,
        expected: String(plan.version),
        actual: deployedVersion,
      }),
    );

  return issues;
}

function compareNetworkResources(
  plan: VpsRuntimePlan,
  networks: ReadonlyMap<string, ObservedNetwork>,
): RuntimeDriftEntry[] {
  const issues: RuntimeDriftEntry[] = [];
  for (const network of plan.networks) {
    const observed = networks.get(network.dockerName);
    if (!observed) {
      issues.push(
        entry({
          id: 'network.missing',
          kind: 'missing',
          severity: 'warning',
          resourceKind: 'network',
          resource: network.name,
          dockerName: network.dockerName,
          ownership: 'unmanaged',
          message: `Network "${network.dockerName}" does not exist`,
          expected: network.dockerName,
        }),
      );
      continue;
    }
    const ownership = effectiveOwnership(plan, 'network', network.dockerName, observed.ownership);
    const conflict = ownershipEntry('network', network.name, network.dockerName, ownership);
    if (conflict) issues.push(conflict);

    // Docker cannot change these in place, so a mismatch means the network has
    // to be recreated — which means detaching every container on it. Recording
    // it as drift is what lets the preview say so out loud.
    if (observed.driver !== network.driver)
      issues.push(
        entry({
          id: 'network.driver.modified',
          kind: 'modified',
          severity: 'warning',
          resourceKind: 'network',
          resource: network.name,
          dockerName: network.dockerName,
          ownership,
          message: `Network "${network.dockerName}" uses the "${observed.driver}" driver, the plan describes "${network.driver}". Changing it requires recreating the network.`,
          expected: network.driver,
          actual: observed.driver,
        }),
      );
    if (observed.internal !== network.internal)
      issues.push(
        entry({
          id: 'network.internal.modified',
          kind: 'modified',
          severity: network.internal ? 'error' : 'warning',
          resourceKind: 'network',
          resource: network.name,
          dockerName: network.dockerName,
          ownership,
          message: network.internal
            ? `Network "${network.dockerName}" is not internal, but the plan describes it as internal: services on it can reach the internet and be reached through the host`
            : `Network "${network.dockerName}" is internal, but the plan does not describe it as internal: services on it have no route out`,
          expected: String(network.internal),
          actual: String(observed.internal),
        }),
      );
  }
  return issues;
}

function unexpectedResources(
  plan: VpsRuntimePlan,
  observation: RuntimeObservation,
): RuntimeDriftEntry[] {
  const issues: RuntimeDriftEntry[] = [];
  const plannedNetworks = new Set(plan.networks.map((network) => network.dockerName));
  const plannedContainers = new Set(
    plan.services
      .filter((service) => (service.runtimeKind ?? 'container') === 'container')
      .map((service) => service.containerName),
  );
  const plannedVolumes = new Set(plan.volumes.map((volume) => volume.dockerName));

  for (const network of observation.networks) {
    if (plannedNetworks.has(network.name) || !isOwnedByTarget(plan, 'network', network)) continue;
    issues.push(
      entry({
        id: 'network.unexpected',
        kind: 'unexpected',
        severity: 'warning',
        resourceKind: 'network',
        resource: network.name,
        dockerName: network.name,
        ownership: network.ownership,
        message:
          network.containerNames.length > 0
            ? `CloudForge manages network "${network.name}" but the plan no longer describes it. ${String(network.containerNames.length)} container(s) are still attached, so it cannot be removed.`
            : `CloudForge manages network "${network.name}" but the plan no longer describes it`,
        actual: network.name,
      }),
    );
  }

  for (const container of observation.containers) {
    if (plannedContainers.has(container.name) || !isOwnedByTarget(plan, 'container', container))
      continue;
    issues.push(
      entry({
        id: 'container.unexpected',
        kind: 'unexpected',
        severity: 'warning',
        resourceKind: 'container',
        resource: container.name,
        dockerName: container.name,
        ownership: container.ownership,
        message: `CloudForge manages container "${container.name}" but the plan no longer describes it`,
        actual: container.name,
      }),
    );
  }

  // Volumes hold the data. An unexpected one is reported and never proposed for
  // removal — a wrong verdict here is unrecoverable in a way a container is not.
  for (const volume of observation.volumes) {
    if (plannedVolumes.has(volume.name) || !isOwnedByTarget(plan, 'volume', volume)) continue;
    issues.push(
      entry({
        id: 'volume.unexpected',
        kind: 'unexpected',
        severity: 'info',
        resourceKind: 'volume',
        resource: volume.name,
        dockerName: volume.name,
        ownership: volume.ownership,
        message: `CloudForge manages volume "${volume.name}" but the plan no longer describes it. Volumes are never removed automatically.`,
        actual: volume.name,
      }),
    );
  }
  return issues;
}

function compareVolumes(
  plan: VpsRuntimePlan,
  volumes: ReadonlyMap<string, ObservedVolume>,
): RuntimeDriftEntry[] {
  const issues: RuntimeDriftEntry[] = [];
  for (const volume of plan.volumes) {
    const observed = volumes.get(volume.dockerName);
    if (!observed) {
      issues.push(
        entry({
          id: 'volume.missing',
          kind: 'missing',
          severity: 'warning',
          resourceKind: 'volume',
          resource: volume.name,
          dockerName: volume.dockerName,
          ownership: 'unmanaged',
          message: `Volume "${volume.dockerName}" does not exist`,
          expected: volume.dockerName,
        }),
      );
      continue;
    }
    const conflict = ownershipEntry(
      'volume',
      volume.name,
      volume.dockerName,
      effectiveOwnership(plan, 'volume', volume.dockerName, observed.ownership),
    );
    if (conflict) issues.push(conflict);
  }
  return issues;
}

/**
 * Compare desired runtime against observed runtime.
 *
 * A `legacy`-mode plan describes no intent, so it produces no drift: an install
 * that has never been managed must look clean, not present the user with a wall
 * of findings about a server that is working fine.
 */
export function detectRuntimeDrift(
  plan: VpsRuntimePlan,
  observation: RuntimeObservation,
): RuntimeDriftReport {
  const entries: RuntimeDriftEntry[] = [];

  if (observation.targetId !== plan.targetId) {
    entries.push(
      entry({
        id: 'observation.mismatch',
        kind: 'modified',
        severity: 'error',
        resourceKind: 'container',
        resource: '',
        dockerName: '',
        ownership: 'unmanaged',
        message: `This observation is of target "${observation.targetId}", not "${plan.targetId}"`,
        expected: plan.targetId,
        actual: observation.targetId,
      }),
    );
    return report(plan, observation, entries);
  }

  // Without Docker every planned resource would read as missing, which says
  // nothing useful. One accurate finding beats a page of derived ones.
  if (!observation.docker.available) {
    const needsDocker =
      plan.networks.length > 0 ||
      plan.volumes.length > 0 ||
      plan.services.some((service) => (service.runtimeKind ?? 'container') === 'container');
    if (plan.mode !== 'legacy' && needsDocker)
      entries.push(
        entry({
          id: 'docker.unavailable',
          kind: 'missing',
          severity: 'error',
          resourceKind: 'container',
          resource: '',
          dockerName: '',
          ownership: 'unmanaged',
          message: 'Docker is not available on this target, so no runtime resource can exist',
        }),
      );
    if (plan.mode === 'legacy') return report(plan, observation, entries);
    entries.push(...topologyResourceDrift(plan));
    return report(plan, observation, entries);
  }

  if (plan.mode === 'legacy') return report(plan, observation, entries);

  const containers = new Map(
    observation.containers.map((container) => [container.name, container]),
  );
  const networks = new Map(observation.networks.map((network) => [network.name, network]));
  const volumes = new Map(observation.volumes.map((volume) => [volume.name, volume]));

  entries.push(...compareNetworkResources(plan, networks));
  entries.push(...compareVolumes(plan, volumes));
  for (const service of plan.services) entries.push(...compareService(plan, service, containers));
  entries.push(...unexpectedResources(plan, observation));
  entries.push(...topologyResourceDrift(plan));

  return report(plan, observation, entries);
}

function topologyResourceDrift(plan: VpsRuntimePlan): RuntimeDriftEntry[] {
  const entries: RuntimeDriftEntry[] = [];
  for (const certificate of plan.certificates ?? []) {
    if (certificate.status === 'valid') continue;
    entries.push(
      entry({
        id: `certificate.${certificate.status}`,
        kind: certificate.status === 'missing' ? 'missing' : 'modified',
        severity:
          certificate.status === 'expired' || certificate.status === 'missing'
            ? 'error'
            : certificate.status === 'expiring'
              ? 'warning'
              : 'info',
        resourceKind: 'certificate',
        resource: certificate.domain,
        dockerName: certificate.domain,
        ownership: certificate.source.ownership,
        message:
          certificate.status === 'missing'
            ? `The certificate for ${certificate.domain} was previously managed but is no longer present`
            : certificate.status === 'changed'
              ? `The certificate fingerprint for ${certificate.domain} changed outside CloudForge`
              : `Certificate ${certificate.domain} is ${certificate.status}`,
        ...(certificate.status === 'changed' && certificate.fingerprint
          ? { expected: certificate.fingerprint }
          : {}),
        ...(certificate.status === 'changed' && certificate.observedFingerprint
          ? { actual: certificate.observedFingerprint }
          : {}),
        ...(certificate.expiresAt && certificate.status !== 'changed'
          ? { actual: certificate.expiresAt }
          : {}),
      }),
    );
  }
  for (const record of plan.dnsRecords ?? []) {
    if (record.status === 'active' && record.targetId === plan.targetId) continue;
    entries.push(
      entry({
        id: record.targetId === plan.targetId ? `dns.${record.status}` : 'dns.target.modified',
        kind: record.status === 'missing' ? 'missing' : 'modified',
        severity:
          record.status === 'error' ||
          record.status === 'missing' ||
          record.targetId !== plan.targetId
            ? 'error'
            : 'warning',
        resourceKind: 'dns',
        resource: record.domain,
        dockerName: record.recordId,
        ownership: record.source.ownership,
        message:
          record.status === 'missing'
            ? `${record.domain} was previously managed but is no longer present in Cloudflare`
            : record.targetId !== plan.targetId
              ? `${record.domain} no longer points to this saved VPS target`
              : `DNS record ${record.domain} is ${record.status}`,
        expected: plan.targetId,
        actual: record.targetId ?? record.content,
      }),
    );
  }
  return entries;
}

function report(
  plan: VpsRuntimePlan,
  observation: RuntimeObservation,
  entries: readonly RuntimeDriftEntry[],
): RuntimeDriftReport {
  const counts: Record<DriftSeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const item of entries) counts[item.severity] += 1;
  return {
    targetId: plan.targetId,
    planVersion: plan.version,
    observedAt: observation.observedAt,
    inSync: entries.length === 0,
    counts,
    entries,
  };
}

/** Drift that must be resolved by a person before an apply can be trusted. */
export function blockingDrift(report: RuntimeDriftReport): readonly RuntimeDriftEntry[] {
  return report.entries.filter(
    (item) => item.kind === 'ownership-conflict' || item.kind === 'adoptable',
  );
}
