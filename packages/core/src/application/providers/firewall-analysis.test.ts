import { describe, expect, it } from 'vitest';
import type { LiveFirewallRule } from './cloud-provider.js';
import { firewallAllowsPublicPort, firewallWarnings } from './firewall-analysis.js';

const rule = (patch: Partial<LiveFirewallRule>): LiveFirewallRule => ({
  id: 'r1',
  direction: 'ingress',
  protocol: 'tcp',
  cidr: '10.0.0.0/8',
  portFrom: 443,
  portTo: 443,
  description: 'web',
  stateless: false,
  ...patch,
});

describe('firewallWarnings', () => {
  it('stays silent about a private, stateful rule', () => {
    expect(firewallWarnings([rule({})])).toEqual([]);
  });

  it('flags SSH and all traffic open to the internet', () => {
    expect(firewallWarnings([rule({ cidr: '0.0.0.0/0', portFrom: 22, portTo: 22 })])).toEqual([
      'SSH is open to the entire internet.',
    ]);
    expect(
      firewallWarnings([
        rule({ cidr: '0.0.0.0/0', protocol: 'all', portFrom: null, portTo: null }),
      ]),
    ).toEqual(['All inbound traffic is open to the entire internet.']);
  });

  it('flags duplicates and overlapping ranges without repeating itself', () => {
    const warnings = firewallWarnings([rule({ id: 'a' }), rule({ id: 'b' })]);
    expect(warnings.some((warning) => warning.startsWith('Duplicate rule'))).toBe(true);
    expect(warnings.some((warning) => warning.startsWith('Overlapping TCP'))).toBe(true);
    expect(new Set(warnings).size).toBe(warnings.length);
  });

  it('warns that a stateless inbound rule needs its response rule', () => {
    expect(firewallWarnings([rule({ stateless: true })])[0]).toContain('Stateless inbound TCP');
  });
});

describe('firewallAllowsPublicPort', () => {
  it('needs an inbound rule from anywhere that covers the port', () => {
    const open = rule({ cidr: '0.0.0.0/0', portFrom: 80, portTo: 443 });
    expect(firewallAllowsPublicPort([open], 443)).toBe(true);
    expect(firewallAllowsPublicPort([open], 22)).toBe(false);
    expect(firewallAllowsPublicPort([rule({})], 443)).toBe(false);
    expect(firewallAllowsPublicPort([{ ...open, direction: 'egress' }], 443)).toBe(false);
  });

  it('treats a rule with no ports as covering every port', () => {
    const open = rule({ cidr: '::/0', protocol: 'all', portFrom: null, portTo: null });
    expect(firewallAllowsPublicPort([open], 5432)).toBe(true);
  });
});
