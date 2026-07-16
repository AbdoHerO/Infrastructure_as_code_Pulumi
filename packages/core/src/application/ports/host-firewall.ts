import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

/**
 * The VPS's own firewall — the second of the two that decide whether a port is
 * reachable.
 *
 * A cloud provider's security list and the host firewall are independent, and a
 * port is only reachable when *both* allow it. That fact was previously spread
 * across a preflight probe, a certificate script, a playbook and an Ansible
 * verification step, each with its own copy of the same shell, drifting apart.
 * This port is the one place that models it.
 */

export const HOST_FIREWALL_BACKENDS = [
  'ufw',
  'firewalld',
  'nftables',
  'iptables',
  'none',
  'unknown',
] as const;

/**
 * Which firewall is in charge on this host.
 *
 * - `none` — a firewall tool exists but is inactive, or none is installed. The
 *   host filters nothing; only the provider's rules matter.
 * - `unknown` — the probe could not tell. Never treated as `none`: assuming a
 *   port is open because we failed to look is how a service silently fails to be
 *   reachable, and assuming it is closed is how CloudForge would open a hole
 *   nobody asked for.
 */
export type HostFirewallBackend = (typeof HOST_FIREWALL_BACKENDS)[number];

export interface HostFirewallPort {
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
}

export interface HostFirewallRule extends HostFirewallPort {
  /**
   * True when the rule carries CloudForge's marker comment.
   *
   * `ufw` and `firewalld` cannot record a comment on a simple port rule, so on
   * those backends this is always false and a rule's origin is genuinely
   * unknowable from the host. That is why closing is never automatic.
   */
  readonly managed: boolean;
  /** The backend's own description of the rule, for display. */
  readonly raw: string;
}

export interface HostFirewallState {
  readonly backend: HostFirewallBackend;
  /** False when the backend is installed but switched off. */
  readonly active: boolean;
  readonly rules: readonly HostFirewallRule[];
  /** True when the probe could not determine the state. `rules` is then empty. */
  readonly indeterminate: boolean;
}

/**
 * Reads and changes a host's firewall.
 *
 * `open` is idempotent and additive. There is deliberately no "reconcile" or
 * "sync": a rule CloudForge did not create must never be removed because a plan
 * stopped mentioning it — a VPS's firewall is full of rules put there by people
 * and other tools for reasons CloudForge cannot see. `close` exists, but only
 * ever removes exactly what it is told to.
 */
export interface HostFirewallManager {
  inspect(target: DeploymentTarget): Promise<Result<HostFirewallState, DeploymentError>>;
  open(
    target: DeploymentTarget,
    ports: readonly HostFirewallPort[],
  ): Promise<Result<HostFirewallState, DeploymentError>>;
  close(
    target: DeploymentTarget,
    ports: readonly HostFirewallPort[],
  ): Promise<Result<HostFirewallState, DeploymentError>>;
}
