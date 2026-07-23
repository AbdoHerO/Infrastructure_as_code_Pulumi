import { Badge } from '@cloudforge/ui';
import type { ObservedPort } from '@cloudforge/core';

/**
 * A container's ports, with the distinction the old view collapsed.
 *
 * `docker ps` renders `8080/tcp` for a port merely exposed inside Docker and
 * `0.0.0.0:80->80/tcp` for one published to every interface. The previous UI
 * printed that string verbatim behind the label "no published ports", so an
 * exposed-only container read as published, and a loopback-only publish was
 * indistinguishable from one open to the internet. These are four different
 * answers to "who can reach this", and they are shown as four different things.
 */

type Reach = 'internal' | 'loopback' | 'public';

function reachOf(port: ObservedPort): Reach {
  if (port.exposure === 'internal') return 'internal';
  return port.exposure === 'host-loopback' ? 'loopback' : 'public';
}

const DESCRIPTION: Record<Reach, string> = {
  internal:
    'Exposed inside Docker only. Reachable by containers on a shared network; not reachable from this VPS or the internet.',
  loopback:
    'Published on the loopback interface. Reachable from the VPS itself — for example by a reverse proxy — but never from another machine.',
  public:
    'Published on a routable interface. Reachable from anywhere the VPS firewall and the cloud firewall allow.',
};

const LABEL: Record<Reach, string> = {
  internal: 'Internal',
  loopback: 'Loopback',
  public: 'Public',
};

const VARIANT: Record<Reach, 'secondary' | 'success' | 'destructive'> = {
  internal: 'secondary',
  loopback: 'success',
  public: 'destructive',
};

function portText(port: ObservedPort): string {
  if (port.hostPort === null) return `${port.containerPort}/${port.protocol}`;
  return `${port.bindAddress ?? '0.0.0.0'}:${port.hostPort} → ${port.containerPort}/${port.protocol}`;
}

export function ContainerPorts({ ports }: { ports: readonly ObservedPort[] }): JSX.Element {
  if (ports.length === 0) {
    return <p className="text-muted-foreground text-xs">Declares no ports.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ports.map((port) => {
        const reach = reachOf(port);
        return (
          <li
            key={`${port.containerPort}-${port.protocol}-${port.hostPort ?? 'x'}-${port.bindAddress ?? ''}`}
          >
            <Badge variant={VARIANT[reach]} title={DESCRIPTION[reach]}>
              <span className="font-mono text-[11px]">{portText(port)}</span>
              <span className="ml-1.5 opacity-80">{LABEL[reach]}</span>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

/** True when any port is reachable from outside the VPS. */
export function hasPublicPort(ports: readonly ObservedPort[]): boolean {
  return ports.some((port) => reachOf(port) === 'public');
}
