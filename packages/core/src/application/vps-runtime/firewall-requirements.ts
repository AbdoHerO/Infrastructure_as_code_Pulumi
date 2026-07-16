/**
 * What a runtime plan needs from the two firewalls in front of it.
 *
 * A port on a VPS is reachable only when the cloud provider's security list
 * *and* the host's own firewall both allow it. Nothing modelled that. The
 * provider firewall was edited on one page, the host firewall was opened as a
 * side effect of four unrelated scripts, and whether a given service was
 * actually reachable was a question no part of CloudForge could answer.
 *
 * This derives the answer from the plan, purely, so both firewalls can be
 * checked against one list.
 */
import { isLoopbackAddress, isWildcardAddress } from './runtime-ownership.js';
import type { VpsRuntimePlan } from './vps-runtime-plan.js';

export interface FirewallRequirement {
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
  /** Why this port is needed, in words a person can act on. */
  readonly reason: string;
  /** The plan resources that need it. */
  readonly requiredBy: readonly string[];
}

/**
 * Ports the reverse proxy needs, when the plan has routes.
 *
 * Derived from the plan's routes rather than assumed: a target with no route
 * needs neither, and opening 80 and 443 on a VPS that serves nothing is a hole
 * for no reason.
 */
function proxyRequirements(plan: VpsRuntimePlan): FirewallRequirement[] {
  if (plan.reverseProxy === 'none' || plan.reverseProxy === 'external') return [];
  if (plan.routes.length === 0) return [];
  const requirements: FirewallRequirement[] = [];
  const plainDomains = plan.routes.filter((r) => !r.tls).map((r) => r.domain);
  const tlsDomains = plan.routes.filter((r) => r.tls).map((r) => r.domain);

  // 80 is required even when every route is HTTPS: an ACME HTTP-01 challenge
  // arrives on 80, so closing it is how certificate renewal silently starts
  // failing 60 days later.
  requirements.push({
    port: 80,
    protocol: 'tcp',
    reason:
      tlsDomains.length > 0 && plainDomains.length === 0
        ? 'HTTP, for the redirect to HTTPS and for Let’s Encrypt renewal, which is answered on port 80'
        : 'HTTP traffic to this target’s routes',
    requiredBy: [...new Set([...plainDomains, ...tlsDomains])],
  });
  if (tlsDomains.length > 0)
    requirements.push({
      port: 443,
      protocol: 'tcp',
      reason: 'HTTPS traffic to this target’s routes',
      requiredBy: [...new Set(tlsDomains)],
    });
  return requirements;
}

/**
 * Ports the plan's services publish to the world.
 *
 * Only `direct` exposure on a non-loopback address counts. A `host-loopback`
 * port is reachable from the VPS itself and nowhere else — no firewall rule can
 * make it reachable and none is needed — and conflating the two is how a
 * database bound to 127.0.0.1 ends up with a hole opened for it in a security
 * list, for traffic that could never arrive.
 */
function serviceRequirements(plan: VpsRuntimePlan): FirewallRequirement[] {
  const byKey = new Map<string, { port: number; protocol: 'tcp' | 'udp'; services: string[] }>();
  for (const service of plan.services) {
    if (service.exposure !== 'direct') continue;
    for (const mapping of service.ports) {
      if (mapping.hostPort === undefined) continue;
      const bind = mapping.bindAddress;
      if (bind !== undefined && !isWildcardAddress(bind) && isLoopbackAddress(bind)) continue;
      const key = `${String(mapping.hostPort)}/${mapping.protocol}`;
      const existing = byKey.get(key);
      if (existing) existing.services.push(service.name);
      else
        byKey.set(key, {
          port: mapping.hostPort,
          protocol: mapping.protocol,
          services: [service.name],
        });
    }
  }
  return [...byKey.values()].map((entry) => ({
    port: entry.port,
    protocol: entry.protocol,
    reason: `Published directly by ${entry.services.join(', ')}`,
    requiredBy: entry.services,
  }));
}

/**
 * Every port this plan needs open, on both firewalls.
 *
 * Deliberately does not include SSH. CloudForge is talking to the VPS over SSH
 * to ask the question, so the port is demonstrably open; listing it would invite
 * a "reconcile" that closes the door CloudForge is standing in.
 */
export function firewallRequirements(plan: VpsRuntimePlan): readonly FirewallRequirement[] {
  if (plan.mode === 'legacy') return [];
  const merged = new Map<string, FirewallRequirement>();
  for (const requirement of [...proxyRequirements(plan), ...serviceRequirements(plan)]) {
    const key = `${String(requirement.port)}/${requirement.protocol}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, requirement);
      continue;
    }
    merged.set(key, {
      ...existing,
      reason: `${existing.reason}; ${requirement.reason}`,
      requiredBy: [...new Set([...existing.requiredBy, ...requirement.requiredBy])],
    });
  }
  return [...merged.values()].sort(
    (a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol),
  );
}

export const CONNECTIVITY_STATES = [
  'reachable',
  'blocked-host',
  'blocked-provider',
  'blocked-both',
  'unknown',
] as const;

/**
 * Whether traffic can actually arrive on a port.
 *
 * - `blocked-host` / `blocked-provider` / `blocked-both` — which of the two
 *   firewalls is in the way. Naming it is the whole point: "the port is closed"
 *   sends someone to the wrong screen half the time.
 * - `unknown` — one of the two could not be read. Never reported as reachable.
 */
export type ConnectivityState = (typeof CONNECTIVITY_STATES)[number];

export interface ConnectivityFinding {
  readonly port: number;
  readonly protocol: 'tcp' | 'udp';
  readonly state: ConnectivityState;
  readonly reason: string;
  readonly requiredBy: readonly string[];
  readonly message: string;
}

export interface FirewallView {
  /** Ports the firewall allows. */
  readonly allowed: ReadonlySet<string>;
  /** True when this firewall's state could not be determined. */
  readonly indeterminate: boolean;
  /** True when nothing is being filtered, so every port is allowed. */
  readonly permitsEverything: boolean;
}

/** `port/protocol`, the key both firewall views are indexed by. */
export function portKey(port: number, protocol: string): string {
  return `${String(port)}/${protocol}`;
}

/** CIDRs that mean "from anywhere on the internet". */
const WORLD = new Set(['0.0.0.0/0', '::/0']);

/**
 * Turn a cloud provider's security list into a firewall view.
 *
 * Three things decide whether a provider rule actually opens a port, and
 * missing any of them produces a confident wrong answer:
 *
 * - **Direction.** Only ingress lets traffic in. An egress rule for 443 says
 *   nothing about whether anyone can reach you on it.
 * - **Source.** A rule allowing 5432 from `10.0.0.0/8` opens the port to the
 *   private subnet, not to the internet. Counting it would tell a user their
 *   service is reachable when every request from outside is still dropped.
 * - **Port range.** Providers express "all ports" as a null range, and a rule
 *   for 8000-9000 covers 8080 without naming it.
 *
 * `all` protocol rules match both tcp and udp, which is what the providers mean
 * by it.
 */
export function toProviderFirewallView(
  rules: readonly {
    readonly direction: string;
    readonly protocol: string;
    readonly cidr: string;
    readonly portFrom: number | null;
    readonly portTo: number | null;
  }[],
  requirements: readonly FirewallRequirement[],
): FirewallView {
  const allowed = new Set<string>();
  const ingress = rules.filter(
    (rule) => rule.direction === 'ingress' && WORLD.has(rule.cidr.trim()),
  );

  for (const requirement of requirements) {
    const open = ingress.some((rule) => {
      if (rule.protocol !== 'all' && rule.protocol !== requirement.protocol) return false;
      // A null range is the provider's way of saying every port.
      if (rule.portFrom === null && rule.portTo === null) return true;
      const from = rule.portFrom ?? rule.portTo ?? 0;
      const to = rule.portTo ?? rule.portFrom ?? 65_535;
      return requirement.port >= from && requirement.port <= to;
    });
    if (open) allowed.add(portKey(requirement.port, requirement.protocol));
  }

  return { allowed, indeterminate: false, permitsEverything: false };
}

/**
 * Check a plan's requirements against both firewalls at once.
 *
 * Pure, so the combined answer can be tested without a VPS or a cloud account —
 * which matters, because the interesting cases are the ones nobody can reproduce
 * on demand.
 */
export function checkConnectivity(
  requirements: readonly FirewallRequirement[],
  host: FirewallView,
  provider: FirewallView,
): readonly ConnectivityFinding[] {
  return requirements.map((requirement) => {
    const key = portKey(requirement.port, requirement.protocol);
    const hostOk = host.permitsEverything || host.allowed.has(key);
    const providerOk = provider.permitsEverything || provider.allowed.has(key);
    const unknown = (host.indeterminate && !hostOk) || (provider.indeterminate && !providerOk);

    const state: ConnectivityState = unknown
      ? 'unknown'
      : hostOk && providerOk
        ? 'reachable'
        : !hostOk && !providerOk
          ? 'blocked-both'
          : hostOk
            ? 'blocked-provider'
            : 'blocked-host';

    return {
      port: requirement.port,
      protocol: requirement.protocol,
      state,
      reason: requirement.reason,
      requiredBy: requirement.requiredBy,
      message: describe(state, key),
    };
  });
}

function describe(state: ConnectivityState, key: string): string {
  switch (state) {
    case 'reachable':
      return `${key} is open on both the VPS firewall and the cloud provider.`;
    case 'blocked-host':
      return `${key} is allowed by the cloud provider but blocked by the VPS's own firewall.`;
    case 'blocked-provider':
      return `${key} is open on the VPS but blocked by the cloud provider's firewall, so traffic never reaches the machine.`;
    case 'blocked-both':
      return `${key} is blocked by both the VPS firewall and the cloud provider.`;
    case 'unknown':
      return `${key} could not be checked: one of the two firewalls did not report its state. Treat it as unverified rather than open.`;
  }
}
