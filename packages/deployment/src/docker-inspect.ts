/**
 * Parsers for `docker inspect` output.
 *
 * Pure and free of SSH so they can be tested against real Docker payloads.
 *
 * These read `inspect` rather than `ps` because `ps` cannot answer the question
 * the runtime layer is built around. Its `.Ports` field renders `8080/tcp` for a
 * port merely exposed inside Docker and `0.0.0.0:80->80/tcp` for one published
 * to every interface — one opaque string for two situations with completely
 * different security consequences. `inspect` reports them separately.
 */
import {
  classifyObservedExposure,
  classifyOwnership,
  type ObservedContainer,
  type ObservedMount,
  type ObservedNetwork,
  type ObservedNetworkAttachment,
  type ObservedPort,
  type ObservedVolume,
} from '@cloudforge/core';

const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';

interface RawBinding {
  readonly HostIp?: string;
  readonly HostPort?: string;
}

interface RawContainer {
  readonly Id?: string;
  readonly Name?: string;
  readonly Created?: string;
  readonly State?: { readonly Status?: string; readonly Health?: { readonly Status?: string } };
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Record<string, string> | null;
    readonly ExposedPorts?: Record<string, unknown> | null;
  };
  readonly HostConfig?: {
    readonly PortBindings?: Record<string, RawBinding[] | null> | null;
    readonly RestartPolicy?: { readonly Name?: string };
  };
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, RawBinding[] | null> | null;
    readonly Networks?: Record<
      string,
      { readonly Aliases?: string[] | null; readonly IPAddress?: string }
    > | null;
  };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Name?: string;
    readonly Source?: string;
    readonly Destination?: string;
    readonly RW?: boolean;
  }[];
}

interface RawNetwork {
  readonly Id?: string;
  readonly Name?: string;
  readonly Driver?: string;
  readonly Internal?: boolean;
  readonly Attachable?: boolean;
  readonly EnableIPv6?: boolean;
  readonly Labels?: Record<string, string> | null;
  readonly Containers?: Record<string, { readonly Name?: string }> | null;
}

interface RawVolume {
  readonly Name?: string;
  readonly Driver?: string;
  readonly Mountpoint?: string;
  readonly Labels?: Record<string, string> | null;
}

/** Parse newline-delimited JSON, skipping anything unreadable rather than failing the sweep. */
export function parseJsonLines<T>(output: string): T[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function labelsOf(raw: Record<string, string> | null | undefined): Record<string, string> {
  return raw ?? {};
}

/** `80/tcp` → its parts. Docker defaults to tcp when a spec omits the protocol. */
function parsePortSpec(spec: string): { port: number; protocol: 'tcp' | 'udp' } | null {
  const [portText, protocolText] = spec.split('/');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { port, protocol: protocolText === 'udp' ? 'udp' : 'tcp' };
}

/**
 * Every port a container declares, published or not.
 *
 * Starts from the exposed set so a port reachable only inside Docker is still
 * reported — it is part of the topology even though nothing outside can see it
 * — then overlays the host bindings. A container port bound on both IPv4 and
 * IPv6 yields one entry per binding, because Docker really did open both.
 */
export function parseContainerPorts(raw: RawContainer): ObservedPort[] {
  const ports = new Map<string, ObservedPort>();
  const add = (port: ObservedPort): void => {
    ports.set(
      `${port.containerPort}/${port.protocol}|${port.bindAddress ?? ''}|${port.hostPort ?? ''}`,
      port,
    );
  };

  for (const spec of Object.keys(raw.Config?.ExposedPorts ?? {})) {
    const parsed = parsePortSpec(spec);
    if (parsed)
      add({
        containerPort: parsed.port,
        protocol: parsed.protocol,
        hostPort: null,
        bindAddress: null,
        exposure: 'internal',
      });
  }

  // A running container reports live bindings; a stopped one only its intent.
  const bindings = raw.NetworkSettings?.Ports ?? raw.HostConfig?.PortBindings ?? {};
  for (const [spec, list] of Object.entries(bindings)) {
    const parsed = parsePortSpec(spec);
    if (!parsed) continue;
    if (!list || list.length === 0) {
      add({
        containerPort: parsed.port,
        protocol: parsed.protocol,
        hostPort: null,
        bindAddress: null,
        exposure: 'internal',
      });
      continue;
    }
    // Published: drop the exposed-only entry so one port is not counted twice.
    ports.delete(`${parsed.port}/${parsed.protocol}||`);
    for (const binding of list) {
      const hostPort = Number(binding.HostPort);
      if (!Number.isInteger(hostPort) || hostPort < 1) continue;
      const bindAddress = binding.HostIp && binding.HostIp.length > 0 ? binding.HostIp : '0.0.0.0';
      add({
        containerPort: parsed.port,
        protocol: parsed.protocol,
        hostPort,
        bindAddress,
        exposure: classifyObservedExposure(hostPort, bindAddress),
      });
    }
  }

  return [...ports.values()].sort(
    (a, b) => a.containerPort - b.containerPort || (a.hostPort ?? 0) - (b.hostPort ?? 0),
  );
}

function parseAttachments(raw: RawContainer): ObservedNetworkAttachment[] {
  return Object.entries(raw.NetworkSettings?.Networks ?? {}).map(([network, settings]) => ({
    network,
    aliases: settings.Aliases ?? [],
    ipAddress: settings.IPAddress && settings.IPAddress.length > 0 ? settings.IPAddress : null,
  }));
}

function parseMounts(raw: RawContainer): ObservedMount[] {
  return (raw.Mounts ?? []).map((mount) => ({
    source: mount.Name ?? mount.Source ?? '',
    destination: mount.Destination ?? '',
    kind: mount.Type ?? 'unknown',
    readOnly: mount.RW === false,
  }));
}

export function parseContainer(raw: RawContainer): ObservedContainer | null {
  const id = raw.Id;
  if (!id) return null;
  const labels = labelsOf(raw.Config?.Labels);
  return {
    id,
    // Docker returns container names with a leading slash.
    name: (raw.Name ?? '').replace(/^\//, ''),
    image: raw.Config?.Image ?? '',
    state: raw.State?.Status ?? 'unknown',
    status: raw.State?.Status ?? 'unknown',
    health: raw.State?.Health?.Status ?? null,
    createdAt: raw.Created ?? null,
    // Docker reports an empty name for "no restart policy"; `??` would keep it.
    restartPolicy: raw.HostConfig?.RestartPolicy?.Name?.trim()
      ? raw.HostConfig.RestartPolicy.Name
      : 'no',
    labels,
    ownership: classifyOwnership({ labels }),
    composeProject: labels[COMPOSE_PROJECT] ?? null,
    composeService: labels[COMPOSE_SERVICE] ?? null,
    ports: parseContainerPorts(raw),
    networks: parseAttachments(raw),
    mounts: parseMounts(raw),
  };
}

export function parseContainers(output: string): ObservedContainer[] {
  return parseJsonLines<RawContainer>(output).flatMap((raw) => {
    const container = parseContainer(raw);
    return container ? [container] : [];
  });
}

export function parseNetworks(output: string): ObservedNetwork[] {
  return parseJsonLines<RawNetwork>(output).flatMap((raw) => {
    if (!raw.Name) return [];
    const labels = labelsOf(raw.Labels);
    return [
      {
        id: raw.Id ?? '',
        name: raw.Name,
        driver: raw.Driver ?? 'bridge',
        internal: raw.Internal === true,
        attachable: raw.Attachable === true,
        ipv6: raw.EnableIPv6 === true,
        labels,
        ownership: classifyOwnership({ labels }),
        containerNames: Object.values(raw.Containers ?? {}).flatMap((container) =>
          container.Name ? [container.Name] : [],
        ),
      },
    ];
  });
}

/**
 * Parse volumes and attribute each to the containers mounting it.
 *
 * `docker volume inspect` does not report its users, so the link is recovered
 * from the containers' own mounts. Without it there is no way to tell that
 * deleting a volume would destroy a running database's data.
 */
export function parseVolumes(
  output: string,
  containers: readonly ObservedContainer[],
): ObservedVolume[] {
  const users = new Map<string, string[]>();
  for (const container of containers) {
    for (const mount of container.mounts) {
      if (mount.kind !== 'volume' || !mount.source) continue;
      users.set(mount.source, [...(users.get(mount.source) ?? []), container.name]);
    }
  }
  return parseJsonLines<RawVolume>(output).flatMap((raw) => {
    if (!raw.Name) return [];
    const labels = labelsOf(raw.Labels);
    return [
      {
        name: raw.Name,
        driver: raw.Driver ?? 'local',
        mountPoint: raw.Mountpoint ?? '',
        labels,
        ownership: classifyOwnership({ labels }),
        containerNames: users.get(raw.Name) ?? [],
      },
    ];
  });
}
