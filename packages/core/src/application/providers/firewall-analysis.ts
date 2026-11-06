import type { LiveFirewallRule } from './cloud-provider.js';

/** Ready-made inbound rules for common services. */
export const FIREWALL_RULE_PRESETS: Readonly<
  Record<string, { readonly protocol: LiveFirewallRule['protocol']; from: number; to: number }>
> = {
  SSH: { protocol: 'tcp', from: 22, to: 22 },
  HTTP: { protocol: 'tcp', from: 80, to: 80 },
  HTTPS: { protocol: 'tcp', from: 443, to: 443 },
  Docker: { protocol: 'tcp', from: 2376, to: 2376 },
  Kubernetes: { protocol: 'tcp', from: 6443, to: 6443 },
  MySQL: { protocol: 'tcp', from: 3306, to: 3306 },
  Postgres: { protocol: 'tcp', from: 5432, to: 5432 },
  Redis: { protocol: 'tcp', from: 6379, to: 6379 },
  Mongo: { protocol: 'tcp', from: 27017, to: 27017 },
};

/**
 * Problems worth reading before a cloud firewall change. They advise and never
 * block: an open SSH port can be exactly what someone means to have.
 */
export function firewallWarnings(rules: readonly LiveFirewallRule[]): string[] {
  const warnings: string[] = [];
  const keys = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.direction}:${rule.protocol}:${rule.cidr}:${rule.portFrom}:${rule.portTo}`;
    if (keys.has(key)) warnings.push(`Duplicate rule: ${rule.description || key}`);
    keys.add(key);
    if (
      rule.direction === 'ingress' &&
      rule.cidr === '0.0.0.0/0' &&
      (rule.protocol === 'all' || rule.portFrom === 22)
    )
      warnings.push(
        rule.portFrom === 22
          ? 'SSH is open to the entire internet.'
          : 'All inbound traffic is open to the entire internet.',
      );
    if (
      rule.direction === 'ingress' &&
      rule.stateless &&
      (rule.protocol === 'tcp' || rule.protocol === 'udp')
    )
      warnings.push(
        `Stateless inbound ${rule.protocol.toUpperCase()} ${rule.portFrom ?? 'all ports'} requires a matching stateless outbound response rule. Use stateful for normal web services.`,
      );
  }
  for (let index = 0; index < rules.length; index += 1) {
    const left = rules[index];
    if (!left) continue;
    for (const right of rules.slice(index + 1)) {
      if (
        left.direction === right.direction &&
        left.protocol === right.protocol &&
        left.cidr === right.cidr &&
        rangesOverlap(left.portFrom, left.portTo, right.portFrom, right.portTo)
      )
        warnings.push(
          `Overlapping ${left.protocol.toUpperCase()} rules for ${left.cidr}: ${left.description || left.id} / ${right.description || right.id}.`,
        );
    }
  }
  return [...new Set(warnings)];
}

/** Whether the cloud firewall lets the internet reach a TCP port. */
export function firewallAllowsPublicPort(
  rules: readonly LiveFirewallRule[],
  port: number,
): boolean {
  return rules.some(
    (rule) =>
      rule.direction === 'ingress' &&
      (rule.protocol === 'tcp' || rule.protocol === 'all') &&
      (rule.cidr === '0.0.0.0/0' || rule.cidr === '::/0') &&
      (rule.portFrom === null || rule.portFrom <= port) &&
      (rule.portTo === null || port <= rule.portTo),
  );
}

function rangesOverlap(
  leftFrom: number | null,
  leftTo: number | null,
  rightFrom: number | null,
  rightTo: number | null,
): boolean {
  if (leftFrom === null || leftTo === null || rightFrom === null || rightTo === null) return true;
  return leftFrom <= rightTo && rightFrom <= leftTo;
}
