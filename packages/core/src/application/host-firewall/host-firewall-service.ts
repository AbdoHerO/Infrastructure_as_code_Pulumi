import { err, ok, type DeploymentError, type Result, ValidationError } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type {
  HostFirewallManager,
  HostFirewallPort,
  HostFirewallState,
} from '../ports/host-firewall.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';

export type HostFirewallServiceError = ValidationError | DeploymentError;

/** The most ports one change may name. A hand-made change is a few ports, never a range. */
export const MAX_HOST_FIREWALL_PORTS = 10;

/**
 * The VPS's own firewall, operated by hand from the Firewall page.
 *
 * Some ports are needed by software CloudForge does not model as a route or a
 * service — a hosting layer running beside it (CloudOps serving HTTPS on 443), a
 * daemon installed by hand. The runtime plan cannot derive those, so its "open
 * required ports" can never open them; this is the explicit, per-port way.
 *
 * Opening is additive and idempotent. Closing removes exactly the ports named —
 * on iptables and nftables only CloudForge's own marked rule — and never the SSH
 * port CloudForge is connected through: that would lock CloudForge out of the
 * server it is managing. Every change is recorded in the activity log.
 */
export class HostFirewallService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly firewall: HostFirewallManager,
    private readonly activities: ActivityService,
  ) {}

  inspect(targetId: string): Promise<Result<HostFirewallState, HostFirewallServiceError>> {
    return this.withTarget(targetId, (target) => this.firewall.inspect(target));
  }

  async open(
    targetId: string,
    ports: readonly HostFirewallPort[],
  ): Promise<Result<HostFirewallState, HostFirewallServiceError>> {
    const valid = validateHostFirewallPorts(ports);
    if (!valid.ok) return valid;
    const result = await this.withTarget(targetId, (target) =>
      this.firewall.open(target, valid.value),
    );
    if (result.ok) {
      this.audit('host.firewall.opened', 'Opened', targetId, valid.value, result.value);
    }
    return result;
  }

  async close(
    targetId: string,
    ports: readonly HostFirewallPort[],
  ): Promise<Result<HostFirewallState, HostFirewallServiceError>> {
    const valid = validateHostFirewallPorts(ports);
    if (!valid.ok) return valid;
    const result = await this.withTarget(targetId, (target) => {
      const ssh = valid.value.find((p) => p.protocol === 'tcp' && p.port === target.port);
      if (ssh) {
        return Promise.resolve(
          err(
            new ValidationError(
              `Port ${String(ssh.port)}/tcp is the SSH port CloudForge reaches this server through; closing it would lock CloudForge out.`,
            ),
          ),
        );
      }
      return this.firewall.close(target, valid.value);
    });
    if (result.ok) {
      this.audit('host.firewall.closed', 'Closed', targetId, valid.value, result.value);
    }
    return result;
  }

  private async withTarget<T>(
    targetId: string,
    action: (target: DeploymentTarget) => Promise<Result<T, HostFirewallServiceError>>,
  ): Promise<Result<T, HostFirewallServiceError>> {
    if (!targetId.trim()) return err(new ValidationError('Select a saved VPS target'));
    const resolved = await this.targets.resolve(targetId);
    return resolved.ok ? action(resolved.value) : resolved;
  }

  private audit(
    type: string,
    verb: string,
    targetId: string,
    ports: readonly HostFirewallPort[],
    state: HostFirewallState,
  ): void {
    const list = ports.map((p) => `${String(p.port)}/${p.protocol}`);
    this.activities.recordSafe({
      type,
      message: `${verb} ${list.join(', ')} on the VPS firewall (${state.backend})`,
      metadata: { targetId, ports: list, backend: state.backend },
    });
  }
}

/**
 * Plain port numbers and tcp/udp only, each named once, at most
 * {@link MAX_HOST_FIREWALL_PORTS}. Every value ends up in a shell script on the
 * server, so it is checked here even though the shell builder checks it again.
 */
export function validateHostFirewallPorts(
  ports: readonly HostFirewallPort[],
): Result<HostFirewallPort[], ValidationError> {
  if (ports.length === 0) return err(new ValidationError('Name at least one port'));
  if (ports.length > MAX_HOST_FIREWALL_PORTS) {
    return err(
      new ValidationError(`At most ${String(MAX_HOST_FIREWALL_PORTS)} ports in one change`),
    );
  }
  const seen = new Set<string>();
  const out: HostFirewallPort[] = [];
  for (const entry of ports) {
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65_535) {
      return err(new ValidationError(`Invalid port ${String(entry.port)}: use 1 to 65535`));
    }
    if (entry.protocol !== 'tcp' && entry.protocol !== 'udp') {
      return err(new ValidationError('The protocol must be tcp or udp'));
    }
    const key = `${String(entry.port)}/${entry.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port: entry.port, protocol: entry.protocol });
  }
  return ok(out);
}

/**
 * Whether the VPS firewall lets a port through, from its inspected state:
 * `true`, `false`, or `null` when the state could not be read.
 */
export function hostFirewallAllows(
  state: HostFirewallState,
  port: number,
  protocol: 'tcp' | 'udp',
): boolean | null {
  if (state.indeterminate || state.backend === 'unknown') return null;
  if (state.backend === 'none' || !state.active) return true;
  return state.rules.some((rule) => rule.port === port && rule.protocol === protocol);
}
