/**
 * What the natively-installed services on a VPS need from its firewalls.
 *
 * The runtime plan describes containers. Ansible profiles install things that are
 * not containers — Jenkins, Nginx, Portainer — and those listen on host ports
 * too. Before this, the two halves could not see each other: the connectivity
 * check knew every port a Compose service published and nothing at all about the
 * Jenkins on 8080 that the same page had just installed, so it would report a
 * target as fully reachable while its Jenkins was firewalled off.
 *
 * Pure functions over declared data. Nothing here talks to a VPS, and nothing
 * here decides to open a port — a requirement is a statement that a port *must*
 * be open for a service to work, which is true whether or not CloudForge is the
 * one who opens it. Keeping those separate is what lets the connectivity report
 * explain a service the user firewalled by hand.
 */
import type {
  AnsibleProfile,
  AnsibleProfilePort,
  AnsibleProfileState,
} from '../ports/ansible-manager.js';
import type { FirewallRequirement } from './firewall-requirements.js';
import { portKey } from './firewall-requirements.js';

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

/**
 * Work out which port a spec actually refers to, given the chosen variables.
 *
 * Returns null rather than falling back to the default when the variable holds
 * something unusable. A value we cannot read means we do not know the port, and
 * reporting the default instead would send the user to open a port their service
 * is not listening on — a wrong answer dressed as a confident one.
 */
export function resolveProfilePort(
  spec: AnsibleProfilePort,
  variables: Readonly<Record<string, unknown>>,
): number | null {
  if (spec.variableKey === undefined) return isPort(spec.defaultPort) ? spec.defaultPort : null;
  const raw = variables[spec.variableKey];
  if (raw === undefined || raw === null || raw === '')
    return isPort(spec.defaultPort) ? spec.defaultPort : null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return isPort(value) ? value : null;
}

/**
 * The ports a profile needs open, given how the user configured it.
 *
 * `host` reach is skipped: a port only the VPS itself uses needs no rule, and
 * asking for one would be asking to widen the attack surface for nothing.
 */
export function ansibleFirewallRequirements(
  profile: AnsibleProfile,
  variables: Readonly<Record<string, unknown>> = {},
): readonly FirewallRequirement[] {
  const runtime = profile.runtime;
  if (!runtime) return [];
  const requirements: FirewallRequirement[] = [];
  for (const spec of runtime.ports) {
    if (spec.reach !== 'public') continue;
    const port = resolveProfilePort(spec, variables);
    if (port === null) continue;
    requirements.push({
      port,
      protocol: spec.protocol,
      reason: spec.reason,
      requiredBy: [profile.name],
    });
  }
  return requirements;
}

/**
 * The same, read from what is actually running rather than what was intended.
 *
 * A live port beats a declared default: the service is listening where it is
 * listening, whatever the catalog says, and someone who changed the port by hand
 * afterwards still deserves a correct answer.
 *
 * Only installed profiles count. A profile that is not there needs nothing, and
 * asking for a firewall rule for absent software is how a VPS ends up with open
 * ports nobody can explain.
 */
export function observedAnsibleRequirements(
  profiles: readonly AnsibleProfile[],
  states: readonly AnsibleProfileState[],
): readonly FirewallRequirement[] {
  const requirements: FirewallRequirement[] = [];
  for (const state of states) {
    if (!state.installed) continue;
    const profile = profiles.find((entry) => entry.id === state.profileId);
    if (!profile?.runtime) continue;
    for (const spec of profile.runtime.ports) {
      if (spec.reach !== 'public') continue;
      // The probe reports one port per profile, so it can only stand in for the
      // configurable one. A profile's fixed ports keep their declared values.
      const live = spec.variableKey !== undefined && isPort(state.port) ? state.port : null;
      const port = live ?? resolveProfilePort(spec, {});
      if (port === null) continue;
      requirements.push({
        port,
        protocol: spec.protocol,
        reason: spec.reason,
        requiredBy: [profile.name],
      });
    }
  }
  return requirements;
}

/**
 * Fold several sources of requirements into one list.
 *
 * The plan's routes and a native Nginx both need port 80. That is one port with
 * two reasons, not two requirements — reporting it twice would have the UI ask
 * the user to open the same port two times and then show it blocked twice.
 * `requiredBy` unions so the answer to "who needs this?" stays complete.
 */
export function mergeFirewallRequirements(
  ...sources: (readonly FirewallRequirement[])[]
): readonly FirewallRequirement[] {
  const merged = new Map<string, FirewallRequirement>();
  for (const requirement of sources.flat()) {
    const key = portKey(requirement.port, requirement.protocol);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...requirement, requiredBy: [...requirement.requiredBy] });
      continue;
    }
    merged.set(key, {
      ...existing,
      requiredBy: [...new Set([...existing.requiredBy, ...requirement.requiredBy])],
      reason:
        existing.reason === requirement.reason
          ? existing.reason
          : `${existing.reason}; ${requirement.reason}`,
    });
  }
  return [...merged.values()].sort(
    (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol),
  );
}
