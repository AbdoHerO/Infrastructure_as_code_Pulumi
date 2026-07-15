import { describe, expect, it } from 'vitest';
import type { LiveFirewallRule } from './cloud-provider.js';
import { validateFirewallRules } from './provider-connection-service.js';

const rule: LiveFirewallRule = {
  id: 'ssh',
  direction: 'ingress',
  protocol: 'tcp',
  cidr: '10.0.0.0/24',
  portFrom: 22,
  portTo: 22,
  description: 'SSH',
  stateless: false,
};

describe('validateFirewallRules', () => {
  it('accepts a valid CIDR and port range', () => {
    expect(validateFirewallRules([rule]).ok).toBe(true);
  });

  it('rejects invalid octets, ranges, and duplicate identifiers', () => {
    expect(validateFirewallRules([{ ...rule, cidr: '999.1.1.1/32' }]).ok).toBe(false);
    expect(validateFirewallRules([{ ...rule, portFrom: 100, portTo: 10 }]).ok).toBe(false);
    expect(validateFirewallRules([rule, rule]).ok).toBe(false);
    expect(validateFirewallRules([{ ...rule, description: 'x'.repeat(256) }]).ok).toBe(false);
  });
});
