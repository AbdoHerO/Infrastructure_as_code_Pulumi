import { describe, expect, it } from 'vitest';
import type { LiveFirewallRule } from '@cloudforge/core';
import { toOciRule } from './oracle-provider.js';
import { ociErrorMessage } from './oci-client.js';

const rule: LiveFirewallRule = {
  id: 'http',
  direction: 'ingress',
  protocol: 'tcp',
  cidr: '0.0.0.0/0',
  portFrom: 80,
  portTo: 80,
  description: '',
  stateless: false,
};

describe('OCI firewall serialization', () => {
  it('omits empty optional descriptions rejected by OCI', () => {
    expect(toOciRule(rule)).toEqual({
      protocol: '6',
      isStateless: false,
      source: '0.0.0.0/0',
      sourceType: 'CIDR_BLOCK',
      tcpOptions: { destinationPortRange: { min: 80, max: 80 } },
    });
  });

  it('trims and includes non-empty descriptions', () => {
    expect(toOciRule({ ...rule, description: '  HTTP  ' })).toMatchObject({
      description: 'HTTP',
    });
  });

  it('surfaces OCI response details without exposing the raw response body', () => {
    expect(
      ociErrorMessage(
        400,
        JSON.stringify({ code: 'InvalidParameter', message: 'description is invalid' }),
      ),
    ).toBe('OCI request failed with status 400: InvalidParameter: description is invalid');
  });
});
