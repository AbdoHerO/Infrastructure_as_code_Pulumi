import { describe, expect, it } from 'vitest';
import { type InfrastructurePlan, validatePlan } from './infrastructure-plan.js';

const base: Omit<InfrastructurePlan, 'resources'> = { providerKind: 'oracle', config: {} };

describe('validatePlan', () => {
  it('accepts a consistent plan', () => {
    const plan: InfrastructurePlan = {
      ...base,
      resources: [
        { kind: 'network', name: 'vcn', cidrBlock: '10.0.0.0/16' },
        { kind: 'subnet', name: 'sub', networkName: 'vcn', cidrBlock: '10.0.1.0/24', public: true },
        {
          kind: 'compute',
          name: 'web',
          shape: 'VM.Standard.E4.Flex',
          image: 'ubuntu-22.04',
          subnetName: 'sub',
          sshPublicKey: 'ssh-rsa AAA',
          assignPublicIp: true,
        },
      ],
    };
    expect(validatePlan(plan)).toEqual([]);
  });

  it('flags duplicate names and unresolved references', () => {
    const plan: InfrastructurePlan = {
      ...base,
      resources: [
        { kind: 'network', name: 'vcn', cidrBlock: '10.0.0.0/16' },
        { kind: 'network', name: 'vcn', cidrBlock: '10.1.0.0/16' },
        {
          kind: 'subnet',
          name: 'sub',
          networkName: 'missing',
          cidrBlock: '10.0.1.0/24',
          public: false,
        },
        {
          kind: 'compute',
          name: 'web',
          shape: 's',
          image: 'i',
          subnetName: 'nope',
          sshPublicKey: 'k',
          assignPublicIp: false,
        },
      ],
    };
    const issues = validatePlan(plan);
    expect(issues).toContainEqual({ resource: 'vcn', message: 'Duplicate resource name' });
    expect(issues).toContainEqual({ resource: 'sub', message: 'Unknown network "missing"' });
    expect(issues).toContainEqual({ resource: 'web', message: 'Unknown subnet "nope"' });
  });
});
