/**
 * A provider-agnostic, declarative description of a VPS's desired runtime.
 *
 * The counterpart to `InfrastructurePlan`, one layer up: infrastructure
 * describes the machine, this describes what runs on it. Same shape — a pure
 * interface tree plus one pure validator, no Docker or Compose type anywhere —
 * so the model can be reasoned about and tested without a VPS.
 *
 * The runtime layer grew feature by feature, so the same facts were restated in
 * playbooks, verification commands, preflight lookups and UI branches, and
 * drifted apart. This is the one place they are stated.
 *
 * Resources reference each other by **logical name**, never by Docker id: a plan
 * is authored before anything exists, and must survive a container being
 * recreated with a new id.
 */
import type { ExposureMode } from './runtime-ownership.js';

/** How much of a VPS's runtime CloudForge owns. */
export const RUNTIME_MODES = ['legacy', 'hybrid', 'managed'] as const;

/**
 * - `legacy` — observe only. Nothing is changed. Every existing install starts
 *   here, so upgrading CloudForge can never alter a running server.
 * - `hybrid` — CloudForge owns networks, routes and runtime metadata while
 *   existing Compose and Jenkins workflows continue to own the services.
 * - `managed` — CloudForge owns the whole topology contract.
 */
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const REVERSE_PROXY_MODES = [
  'native-nginx',
  'container-nginx',
  'container-traefik',
  'container-caddy',
  'external',
  'none',
] as const;

/** Which reverse proxy fronts this VPS, and where it runs. */
export type ReverseProxyMode = (typeof REVERSE_PROXY_MODES)[number];

export const RUNTIME_NETWORK_SCOPES = [
  'shared-proxy',
  'application-private',
  'management',
  'custom',
] as const;

/**
 * What a network is for.
 *
 * - `shared-proxy` — joins the reverse proxy to whatever it fronts. The only
 *   network that should span applications.
 * - `application-private` — one application's own services. Internal by default:
 *   a database has no business being reachable from anywhere else.
 * - `management` — administrative tooling.
 * - `custom` — user-defined.
 */
export type RuntimeNetworkScope = (typeof RUNTIME_NETWORK_SCOPES)[number];

export const RUNTIME_NETWORK_DRIVERS = ['bridge', 'overlay', 'macvlan'] as const;
export type RuntimeNetworkDriver = (typeof RUNTIME_NETWORK_DRIVERS)[number];

export interface RuntimeNetwork {
  /** Stable logical name, unique within a plan. Services reference this. */
  readonly name: string;
  /** The name Docker actually uses. Configurable so it can avoid a collision. */
  readonly dockerName: string;
  readonly displayName: string;
  readonly driver: RuntimeNetworkDriver;
  readonly scope: RuntimeNetworkScope;
  /** No route out. Correct for a database network; fatal for one that must pull images. */
  readonly internal: boolean;
  readonly attachable: boolean;
  readonly ipv6: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Well-known service kinds, offered as suggestions.
 *
 * Deliberately not exhaustive and not a closed union: the model must describe
 * applications nobody anticipated, so any slug is valid.
 */
export const KNOWN_SERVICE_KINDS = [
  'web',
  'api',
  'worker',
  'scheduler',
  'websocket',
  'database',
  'cache',
  'queue',
  'search',
  'storage',
  'proxy',
  'management',
  'custom',
] as const;

export type RuntimeServiceKind = string;

export const RUNTIME_SOURCE_MODES = [
  'repository-managed',
  'cloudforge-managed',
  'hybrid-override',
] as const;

/**
 * Who writes an application's Compose definition.
 *
 * - `repository-managed` — the repository owns it; CloudForge observes only.
 * - `cloudforge-managed` — CloudForge generates the whole definition.
 * - `hybrid-override` — the repository owns the services, CloudForge contributes
 *   an override for network attachment, aliases, labels and exposure. The safest
 *   migration path, because the repository keeps working untouched.
 */
export type RuntimeSourceMode = (typeof RUNTIME_SOURCE_MODES)[number];

export interface RuntimeApplication {
  readonly name: string;
  readonly displayName: string;
  /** Compose project grouping this application's containers. */
  readonly composeProject: string;
  readonly sourceMode: RuntimeSourceMode;
  /** CloudForge-owned directory for generated overrides and metadata. */
  readonly runtimeDirectory?: string | undefined;
}

export const SERVICE_REFERENCE_MODES = ['network-alias', 'container-name'] as const;

/**
 * How one service addresses another.
 *
 * Container-to-container traffic must use a Docker DNS name. `localhost` inside
 * a container is *that container*, and a VPS IP leaves the Docker network and
 * comes back through the host — if it works at all. Naming the target service
 * rather than an address is what lets CloudForge check the two can actually
 * reach each other before a deployment rather than after.
 */
export type ServiceReferenceMode = (typeof SERVICE_REFERENCE_MODES)[number];

export interface RuntimeServiceReference {
  /** Environment variable to populate, e.g. `DB_HOST`. Framework-agnostic by design. */
  readonly environmentVariable: string;
  readonly targetServiceName: string;
  readonly valueMode: ServiceReferenceMode;
}

export interface RuntimePortMapping {
  readonly containerPort: number;
  readonly protocol: 'tcp' | 'udp';
  /** Host port. Omitted unless the exposure mode publishes one. */
  readonly hostPort?: number | undefined;
  /** Host interface. Omitted means every interface — the widest exposure. */
  readonly bindAddress?: string | undefined;
  readonly purpose?: string | undefined;
}

export interface RuntimeServiceNetwork {
  readonly networkName: string;
  /** Extra DNS names this service answers to on that network. */
  readonly aliases: readonly string[];
}

export interface RuntimeService {
  readonly name: string;
  readonly applicationName: string;
  readonly kind: RuntimeServiceKind;
  readonly containerName: string;
  readonly image?: string | undefined;
  readonly exposure: ExposureMode;
  readonly ports: readonly RuntimePortMapping[];
  readonly networks: readonly RuntimeServiceNetwork[];
  readonly serviceReferences: readonly RuntimeServiceReference[];
  readonly volumes: readonly string[];
  readonly restartPolicy: string;
}

export interface RuntimeVolume {
  readonly name: string;
  readonly dockerName: string;
  readonly applicationName?: string | undefined;
}

export interface RuntimeRoute {
  readonly domain: string;
  readonly path: string;
  readonly serviceName: string;
  readonly servicePort: number;
  readonly websocket: boolean;
  readonly tls: boolean;
}

/**
 * A pre-existing resource the user has explicitly handed to CloudForge.
 *
 * Ownership of a resource CloudForge *creates* is recorded on the resource
 * itself, as labels. Adoption cannot work that way: Docker labels are fixed when
 * a resource is created and there is no command to change them — no
 * `docker network update` exists at all, and `docker container update` does not
 * touch labels. The only way to label an existing network would be to destroy
 * and recreate it, which would disconnect everything on it. That is the exact
 * opposite of what adopting is supposed to mean.
 *
 * So adoption is recorded here instead. The consequence is honest and worth
 * knowing: this record lives only in CloudForge's database, so a different
 * install looking at the same VPS sees an unmanaged resource and will refuse to
 * touch it — which is the safe direction to fail.
 */
export interface RuntimeAdoption {
  readonly dockerName: string;
  readonly resourceKind: 'container' | 'network' | 'volume';
  readonly adoptedAt: string;
  /** Who or what recorded it, for the audit trail. */
  readonly note?: string | undefined;
}

export const RUNTIME_PLAN_SCHEMA_VERSION = 1;

export interface VpsRuntimePlan {
  readonly schemaVersion: number;
  readonly targetId: string;
  /** Bumped on every save. A build records the version it deployed. */
  readonly version: number;
  readonly mode: RuntimeMode;
  readonly reverseProxy: ReverseProxyMode;
  readonly networks: readonly RuntimeNetwork[];
  readonly applications: readonly RuntimeApplication[];
  readonly services: readonly RuntimeService[];
  readonly volumes: readonly RuntimeVolume[];
  readonly routes: readonly RuntimeRoute[];
  /** Explicitly adopted pre-existing resources. See {@link RuntimeAdoption}. */
  readonly adoptions: readonly RuntimeAdoption[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Docker names the user has explicitly handed to CloudForge, by resource kind. */
export function adoptedDockerNames(
  plan: VpsRuntimePlan,
  resourceKind: RuntimeAdoption['resourceKind'],
): ReadonlySet<string> {
  return new Set(
    plan.adoptions.filter((a) => a.resourceKind === resourceKind).map((a) => a.dockerName),
  );
}

export const ISSUE_SEVERITIES = ['error', 'warning'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/**
 * One problem found in a plan.
 *
 * Richer than `InfrastructurePlan`'s two-string `PlanIssue`, modelled on
 * `VpsPreflightCheck`: a runtime plan can be wrong in ways that merely deserve a
 * warning ("this is open to the internet") as well as ways that must block
 * ("these two services can never reach each other"), and the UI has to tell them
 * apart.
 */
export interface RuntimePlanIssue {
  readonly id: string;
  readonly severity: IssueSeverity;
  /** The logical name of the offending resource, or '' for a whole-plan issue. */
  readonly resource: string;
  readonly message: string;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ENV_VAR = /^[A-Z_][A-Z0-9_]{0,63}$/;
/**
 * Label names that suggest someone is about to publish a secret.
 *
 * Docker labels are readable by anyone who can reach the daemon and are copied
 * into `docker inspect` output, Activity metadata and this plan's JSON. Matching
 * on the *name* rather than the value is deliberate: a value heuristic would
 * flag innocuous strings, while a label literally called `db-password` is never
 * a false positive.
 */
const SECRET_LABEL = /pass(word|wd)?|secret|token|credential|api[-_]?key|private[-_]?key/i;
const DOMAIN = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ROUTE_PATH = /^\/[a-zA-Z0-9/_.-]*$/;

const error = (id: string, resource: string, message: string): RuntimePlanIssue => ({
  id,
  severity: 'error',
  resource,
  message,
});
const warning = (id: string, resource: string, message: string): RuntimePlanIssue => ({
  id,
  severity: 'warning',
  resource,
  message,
});

function validPort(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/**
 * Check a plan's internal consistency before anything acts on it.
 *
 * Pure, synchronous and exhaustive: it returns every issue rather than the first,
 * because a user fixing a topology wants the whole list. An empty array means
 * valid.
 *
 * The rules worth stating plainly:
 *  - a service reference is only meaningful if both services share a network;
 *  - a published host port can only be claimed by one service;
 *  - a route has to point at a service the proxy can actually reach.
 */
export function validateRuntimePlan(plan: VpsRuntimePlan): RuntimePlanIssue[] {
  const issues: RuntimePlanIssue[] = [];

  const networkNames = new Set<string>();
  const dockerNetworkNames = new Set<string>();
  for (const network of plan.networks) {
    if (!SLUG.test(network.name))
      issues.push(error('network.name', network.name, 'Network names must be a lowercase slug'));
    if (networkNames.has(network.name))
      issues.push(error('network.duplicate', network.name, 'Duplicate network name'));
    networkNames.add(network.name);
    if (!DOCKER_NAME.test(network.dockerName))
      issues.push(
        error(
          'network.dockerName',
          network.name,
          `Invalid Docker network name "${network.dockerName}"`,
        ),
      );
    if (dockerNetworkNames.has(network.dockerName))
      issues.push(
        error(
          'network.dockerName.duplicate',
          network.name,
          `Two networks both claim the Docker name "${network.dockerName}"`,
        ),
      );
    dockerNetworkNames.add(network.dockerName);
    for (const label of Object.keys(network.labels)) {
      if (SECRET_LABEL.test(label))
        issues.push(
          error(
            'network.labels.secret',
            network.name,
            `Label "${label}" looks like a secret. Docker labels are readable by anyone with access to the daemon: keep credentials in an encrypted environment file.`,
          ),
        );
    }
    if (network.scope === 'shared-proxy' && network.internal)
      issues.push(
        error(
          'network.proxy.internal',
          network.name,
          'A shared proxy network cannot be internal: the proxy would have no route to the internet',
        ),
      );
  }

  const applicationNames = new Set<string>();
  const composeProjects = new Set<string>();
  for (const application of plan.applications) {
    if (!SLUG.test(application.name))
      issues.push(
        error('application.name', application.name, 'Application names must be a lowercase slug'),
      );
    if (applicationNames.has(application.name))
      issues.push(error('application.duplicate', application.name, 'Duplicate application name'));
    applicationNames.add(application.name);
    if (composeProjects.has(application.composeProject))
      issues.push(
        error(
          'application.composeProject.duplicate',
          application.name,
          `Two applications share the Compose project "${application.composeProject}"`,
        ),
      );
    composeProjects.add(application.composeProject);
  }

  const volumeNames = new Set(plan.volumes.map((volume) => volume.name));
  for (const volume of plan.volumes) {
    if (volume.applicationName && !applicationNames.has(volume.applicationName))
      issues.push(
        error('volume.application', volume.name, `Unknown application "${volume.applicationName}"`),
      );
  }

  const serviceNames = new Set<string>();
  const containerNames = new Map<string, string>();
  // A host port is a machine-wide resource: two services cannot both own one.
  const hostPorts = new Map<string, string>();
  for (const service of plan.services) {
    if (!SLUG.test(service.name))
      issues.push(error('service.name', service.name, 'Service names must be a lowercase slug'));
    if (serviceNames.has(service.name))
      issues.push(error('service.duplicate', service.name, 'Duplicate service name'));
    serviceNames.add(service.name);

    if (!applicationNames.has(service.applicationName))
      issues.push(
        error(
          'service.application',
          service.name,
          `Unknown application "${service.applicationName}"`,
        ),
      );
    if (!DOCKER_NAME.test(service.containerName))
      issues.push(
        error(
          'service.containerName',
          service.name,
          `Invalid container name "${service.containerName}"`,
        ),
      );
    const owner = containerNames.get(service.containerName);
    if (owner)
      issues.push(
        error(
          'service.containerName.duplicate',
          service.name,
          `Container name "${service.containerName}" is already used by "${owner}"`,
        ),
      );
    containerNames.set(service.containerName, service.name);

    for (const attachment of service.networks) {
      if (!networkNames.has(attachment.networkName))
        issues.push(
          error('service.network', service.name, `Unknown network "${attachment.networkName}"`),
        );
      for (const alias of attachment.aliases) {
        if (!DOCKER_NAME.test(alias))
          issues.push(error('service.alias', service.name, `Invalid network alias "${alias}"`));
      }
    }
    if (service.networks.length === 0)
      issues.push(
        warning(
          'service.network.none',
          service.name,
          'Attached to no network: it can neither reach nor be reached by any other service',
        ),
      );

    for (const volume of service.volumes) {
      if (!volumeNames.has(volume))
        issues.push(error('service.volume', service.name, `Unknown volume "${volume}"`));
    }

    for (const port of service.ports) {
      if (!validPort(port.containerPort))
        issues.push(
          error(
            'service.port',
            service.name,
            `Container port must be 1–65535, got ${port.containerPort}`,
          ),
        );
      const publishes = service.exposure === 'direct' || service.exposure === 'host-loopback';
      if (publishes && !validPort(port.hostPort))
        issues.push(
          error(
            'service.hostPort.missing',
            service.name,
            `Exposure "${service.exposure}" publishes a host port, so one must be set`,
          ),
        );
      if (!publishes && port.hostPort !== undefined)
        issues.push(
          error(
            'service.hostPort.unexpected',
            service.name,
            `Exposure "${service.exposure}" publishes nothing, so host port ${port.hostPort} would not be applied`,
          ),
        );
      if (publishes && validPort(port.hostPort)) {
        const key = `${port.bindAddress ?? '0.0.0.0'}:${String(port.hostPort)}/${port.protocol}`;
        const holder = hostPorts.get(key);
        if (holder)
          issues.push(
            error(
              'service.hostPort.conflict',
              service.name,
              `Host port ${key} is already published by "${holder}"`,
            ),
          );
        hostPorts.set(key, service.name);
      }
      if (service.exposure === 'direct' && port.hostPort !== undefined)
        issues.push(
          warning(
            'service.exposure.public',
            service.name,
            `Publishing ${String(port.hostPort)} on ${port.bindAddress ?? 'every interface'} makes it reachable from outside the VPS`,
          ),
        );
    }
  }

  // Service references: both ends must exist and share a network, or the
  // variable resolves to a name Docker DNS cannot answer.
  const networksOf = new Map(
    plan.services.map((service) => [
      service.name,
      new Set(service.networks.map((attachment) => attachment.networkName)),
    ]),
  );
  for (const service of plan.services) {
    const seen = new Set<string>();
    for (const reference of service.serviceReferences) {
      if (!ENV_VAR.test(reference.environmentVariable))
        issues.push(
          error(
            'reference.variable',
            service.name,
            `"${reference.environmentVariable}" is not a valid environment variable name`,
          ),
        );
      if (seen.has(reference.environmentVariable))
        issues.push(
          error(
            'reference.duplicate',
            service.name,
            `${reference.environmentVariable} is referenced twice`,
          ),
        );
      seen.add(reference.environmentVariable);

      if (!serviceNames.has(reference.targetServiceName)) {
        issues.push(
          error(
            'reference.target',
            service.name,
            `Unknown service "${reference.targetServiceName}"`,
          ),
        );
        continue;
      }
      if (reference.targetServiceName === service.name) {
        issues.push(error('reference.self', service.name, 'A service cannot reference itself'));
        continue;
      }
      const mine = networksOf.get(service.name) ?? new Set<string>();
      const theirs = networksOf.get(reference.targetServiceName) ?? new Set<string>();
      const shared = [...mine].some((network) => theirs.has(network));
      if (!shared)
        issues.push(
          error(
            'reference.unreachable',
            service.name,
            `${reference.environmentVariable} points at "${reference.targetServiceName}", but they share no network and cannot communicate`,
          ),
        );
    }
  }

  const routeKeys = new Set<string>();
  for (const route of plan.routes) {
    if (!DOMAIN.test(route.domain))
      issues.push(error('route.domain', route.domain, `Invalid domain "${route.domain}"`));
    if (!ROUTE_PATH.test(route.path))
      issues.push(error('route.path', route.domain, `Invalid route path "${route.path}"`));
    const key = `${route.domain.toLowerCase()}${route.path}`;
    if (routeKeys.has(key))
      issues.push(error('route.duplicate', route.domain, `Duplicate route for ${key}`));
    routeKeys.add(key);
    if (!serviceNames.has(route.serviceName)) {
      issues.push(error('route.service', route.domain, `Unknown service "${route.serviceName}"`));
      continue;
    }
    if (!validPort(route.servicePort))
      issues.push(error('route.port', route.domain, `Invalid service port ${route.servicePort}`));

    // Can the proxy actually reach the service it is routing to?
    //
    // This depends entirely on where the proxy runs, and getting it wrong
    // produces a site that is broken from the moment it is created — nginx
    // reloads happily and every request 502s. It is the same class of mistake as
    // an unreachable service reference, and deserves the same treatment.
    const target = plan.services.find((service) => service.name === route.serviceName);
    if (target) {
      if (plan.reverseProxy === 'native-nginx') {
        // Nginx on the host is not on any Docker network, so a container name
        // means nothing to it: the host's resolver cannot answer Docker DNS.
        // The only way in is a published host port.
        const publishes =
          (target.exposure === 'direct' || target.exposure === 'host-loopback') &&
          target.ports.some((port) => port.containerPort === route.servicePort);
        if (!publishes)
          issues.push(
            error(
              'route.unreachable',
              route.domain,
              `Nginx runs on the host, but "${target.name}" is "${target.exposure}" and publishes no host port for ${String(route.servicePort)}. The host cannot resolve a container name, so this route would return 502. Publish the port on 127.0.0.1, or run the proxy in a container on a shared network.`,
            ),
          );
      } else if (plan.reverseProxy.startsWith('container-')) {
        // A containerised proxy reaches its upstream by Docker DNS, which only
        // works across a shared network.
        const proxyNetworks = new Set(
          plan.networks.filter((n) => n.scope === 'shared-proxy').map((n) => n.name),
        );
        const shared = target.networks.some((attachment) =>
          proxyNetworks.has(attachment.networkName),
        );
        if (proxyNetworks.size === 0)
          issues.push(
            error(
              'route.noProxyNetwork',
              route.domain,
              'The proxy runs in a container but no network has the "shared-proxy" scope, so it has no way to reach anything',
            ),
          );
        else if (!shared)
          issues.push(
            error(
              'route.unreachable',
              route.domain,
              `The proxy runs in a container, but "${target.name}" is on no shared-proxy network, so the proxy cannot resolve or reach it and this route would return 502`,
            ),
          );
      }
    }

    if (plan.reverseProxy === 'none')
      issues.push(
        error(
          'route.noProxy',
          route.domain,
          'A route needs a reverse proxy, but this target has none configured',
        ),
      );
  }

  const adopted = new Set<string>();
  for (const adoption of plan.adoptions) {
    if (!DOCKER_NAME.test(adoption.dockerName))
      issues.push(
        error(
          'adoption.dockerName',
          adoption.dockerName,
          `Invalid Docker name "${adoption.dockerName}"`,
        ),
      );
    const key = `${adoption.resourceKind}:${adoption.dockerName}`;
    if (adopted.has(key))
      issues.push(
        error(
          'adoption.duplicate',
          adoption.dockerName,
          `Adopted twice as a ${adoption.resourceKind}`,
        ),
      );
    adopted.add(key);
  }

  if (plan.mode === 'legacy' && (plan.networks.length > 0 || plan.services.length > 0))
    issues.push(
      warning(
        'plan.legacy',
        '',
        'This target is in legacy mode, so nothing in this plan will be applied until you switch to hybrid or managed',
      ),
    );

  return issues;
}

/** True when a plan has no blocking issue. Warnings do not prevent an apply. */
export function isApplyable(issues: readonly RuntimePlanIssue[]): boolean {
  return !issues.some((issue) => issue.severity === 'error');
}

/**
 * The starting plan for a target CloudForge has never managed.
 *
 * `legacy` mode with nothing in it: an upgrade must never change a running
 * server, so a plan that has not been authored yet describes no intent at all.
 */
export function emptyRuntimePlan(targetId: string, now: Date = new Date()): VpsRuntimePlan {
  const timestamp = now.toISOString();
  return {
    schemaVersion: RUNTIME_PLAN_SCHEMA_VERSION,
    targetId,
    version: 0,
    mode: 'legacy',
    reverseProxy: 'native-nginx',
    networks: [],
    applications: [],
    services: [],
    volumes: [],
    routes: [],
    adoptions: [],
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
