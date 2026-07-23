/**
 * Ownership and exposure vocabulary for a VPS runtime.
 *
 * These are the two questions every other part of the runtime layer asks about
 * a live Docker resource: *did CloudForge create this?* and *who can reach it?*
 * Both were previously implicit — ownership was not recorded at all, and
 * exposure was a `docker ps` display string that conflates a port merely
 * exposed inside Docker with one published to the internet.
 *
 * Provider-independent and free of any Docker type.
 */

/**
 * Labels stamped on every resource CloudForge creates.
 *
 * Ownership must be legible from the resource itself, not inferred: an
 * inventory reads these to know what it may safely change. Nothing secret ever
 * goes in a label — they are world-readable to anyone with Docker access.
 */
export const RUNTIME_LABELS = {
  managed: 'io.cloudforge.managed',
  adopted: 'io.cloudforge.adopted',
  targetId: 'io.cloudforge.target-id',
  applicationId: 'io.cloudforge.application-id',
  serviceId: 'io.cloudforge.service-id',
  planId: 'io.cloudforge.plan-id',
  planVersion: 'io.cloudforge.plan-version',
  resourceKind: 'io.cloudforge.resource-kind',
} as const;

export const RUNTIME_RESOURCE_KINDS = ['container', 'network', 'volume'] as const;
export type RuntimeResourceKind = (typeof RUNTIME_RESOURCE_KINDS)[number];

export const RUNTIME_OWNERSHIPS = [
  'cloudforge-managed',
  'adopted',
  'legacy-managed',
  'unmanaged',
] as const;

/**
 * How much authority CloudForge has over a live resource.
 *
 * - `cloudforge-managed` — created by CloudForge and carrying its labels.
 * - `adopted` — pre-existing, explicitly handed over by a user.
 * - `legacy-managed` — created by a CloudForge release that predates labels.
 *   Recognised, but *not* owned: it must be adopted deliberately.
 * - `unmanaged` — someone else's. Reported, never touched.
 */
export type RuntimeOwnership = (typeof RUNTIME_OWNERSHIPS)[number];

/** True when CloudForge may change a resource without asking first. */
export function isOwned(ownership: RuntimeOwnership): boolean {
  return ownership === 'cloudforge-managed' || ownership === 'adopted';
}

/**
 * Directories earlier releases wrote Compose projects into.
 *
 * A container whose Compose project was built from one of these was created by
 * CloudForge before ownership labels existed. This is evidence, not a guess —
 * only CloudForge writes here — which is why it earns `legacy-managed` rather
 * than `unmanaged`. It still requires explicit adoption.
 */
const LEGACY_PROJECT_ROOTS = ['/opt/cloudforge/compose/', '/opt/cloudforge/apps/'];

const COMPOSE_WORKING_DIR = 'com.docker.compose.project.working_dir';

export interface OwnershipEvidence {
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Decide what CloudForge may do with a resource, from the resource alone.
 *
 * Defaults to `unmanaged`: claiming ownership of something CloudForge did not
 * create is the one mistake here that destroys a user's work, so absence of
 * evidence is never treated as evidence.
 */
export function classifyOwnership(evidence: OwnershipEvidence): RuntimeOwnership {
  const labels = evidence.labels;
  if (labels[RUNTIME_LABELS.managed] === 'true') {
    return labels[RUNTIME_LABELS.adopted] === 'true' ? 'adopted' : 'cloudforge-managed';
  }
  const workingDir = labels[COMPOSE_WORKING_DIR];
  if (workingDir && LEGACY_PROJECT_ROOTS.some((root) => workingDir.startsWith(root)))
    return 'legacy-managed';
  return 'unmanaged';
}

export const EXPOSURE_MODES = ['internal', 'proxy-only', 'host-loopback', 'direct'] as const;

/**
 * How a service is reachable.
 *
 * - `internal` — no host port. Reachable only across a Docker network.
 * - `proxy-only` — no host port; the reverse proxy reaches it by network alias.
 * - `host-loopback` — published on a loopback address only. Reachable from the
 *   VPS itself, never from another machine, and never needs a firewall rule.
 * - `direct` — published on a routable host interface. The only mode that can
 *   expose a service to the internet, and the only one that implies firewall
 *   requirements.
 *
 * `internal` and `proxy-only` are indistinguishable on the wire; they differ in
 * intent, which is what a plan records and an inventory cannot know.
 */
export type ExposureMode = (typeof EXPOSURE_MODES)[number];

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/** True for an address only the VPS itself can reach. */
export function isLoopbackAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, '');
  return LOOPBACK.has(value) || value.startsWith('127.');
}

/** True for a bind address meaning "every interface" — the widest possible exposure. */
export function isWildcardAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, '');
  return value === '0.0.0.0' || value === '::' || value === '*' || value === '';
}

/**
 * Classify a container port from what Docker actually did.
 *
 * Deliberately cannot return `proxy-only`: nothing observable distinguishes a
 * service a proxy reaches by alias from one nothing reaches at all. That
 * distinction is a statement of intent and lives in the plan.
 */
export function classifyObservedExposure(
  hostPort: number | null,
  bindAddress: string | null,
): Exclude<ExposureMode, 'proxy-only'> {
  if (hostPort === null) return 'internal';
  if (bindAddress !== null && isLoopbackAddress(bindAddress)) return 'host-loopback';
  return 'direct';
}

/** True when this exposure can carry traffic from outside the VPS. */
export function isPubliclyReachable(exposure: ExposureMode, bindAddress: string | null): boolean {
  if (exposure !== 'direct') return false;
  return bindAddress === null || !isLoopbackAddress(bindAddress);
}
