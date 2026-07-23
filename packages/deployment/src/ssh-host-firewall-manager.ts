/**
 * Reads and changes a VPS's own firewall over verified SSH.
 *
 * Thin by design: every decision about *which* ports and *whether* to touch them
 * belongs above this, and every line of shell belongs in `host-firewall-script`.
 * This only carries one to the other.
 */
import type {
  DeploymentTarget,
  HostFirewallBackend,
  HostFirewallManager,
  HostFirewallPort,
  HostFirewallState,
} from '@cloudforge/core';
import { HOST_FIREWALL_BACKENDS } from '@cloudforge/core';
import { type DeploymentError, ok, type Result } from '@cloudforge/shared';
import {
  closePortsScript,
  inspectScript,
  openPortsScript,
  parseFirewallState,
} from './host-firewall-script.js';
import { runPrivilegedScript } from './ssh-transport.js';

const LABEL = 'Firewall';
const TIMEOUT_MS = 60_000;

function toBackend(value: string): HostFirewallBackend {
  return (HOST_FIREWALL_BACKENDS as readonly string[]).includes(value)
    ? (value as HostFirewallBackend)
    : 'unknown';
}

/**
 * An inspection that failed to determine anything.
 *
 * Deliberately distinct from "no firewall". Reporting a host with an unreadable
 * firewall as unfiltered would let CloudForge tell a user their port is
 * reachable when it is not — a diagnosis worse than no diagnosis.
 */
const INDETERMINATE: HostFirewallState = {
  backend: 'unknown',
  active: false,
  rules: [],
  indeterminate: true,
};

export class SshHostFirewallManager implements HostFirewallManager {
  async inspect(target: DeploymentTarget): Promise<Result<HostFirewallState, DeploymentError>> {
    const result = await runPrivilegedScript(target, inspectScript(), {
      label: LABEL,
      timeoutMs: TIMEOUT_MS,
    });
    if (!result.ok) return result;
    return ok(toState(result.value.stdout));
  }

  async open(
    target: DeploymentTarget,
    ports: readonly HostFirewallPort[],
  ): Promise<Result<HostFirewallState, DeploymentError>> {
    return this.change(target, openPortsScript(ports), ports);
  }

  async close(
    target: DeploymentTarget,
    ports: readonly HostFirewallPort[],
  ): Promise<Result<HostFirewallState, DeploymentError>> {
    return this.change(target, closePortsScript(ports), ports);
  }

  /**
   * Run a change, then read the firewall back.
   *
   * The verification is the point. A firewall command can succeed and still
   * leave the port unreachable — a `ufw` rule shadowed by an earlier `deny`, an
   * iptables rule inserted below a `REJECT` — so reporting what the host says
   * afterwards is worth more than reporting that the command exited zero.
   */
  private async change(
    target: DeploymentTarget,
    script: string,
    ports: readonly HostFirewallPort[],
  ): Promise<Result<HostFirewallState, DeploymentError>> {
    if (ports.length === 0) return this.inspect(target);
    const applied = await runPrivilegedScript(target, script, {
      label: LABEL,
      timeoutMs: TIMEOUT_MS,
    });
    if (!applied.ok) return applied;
    return this.inspect(target);
  }
}

function toState(stdout: string): HostFirewallState {
  const parsed = parseFirewallState(stdout);
  const backend = toBackend(parsed.backend);
  if (backend === 'unknown') return INDETERMINATE;
  return {
    backend,
    active: parsed.active,
    rules: parsed.rules.map((rule) => ({
      port: rule.port,
      protocol: rule.protocol,
      managed: rule.managed,
      raw: rule.raw,
    })),
    indeterminate: false,
  };
}
