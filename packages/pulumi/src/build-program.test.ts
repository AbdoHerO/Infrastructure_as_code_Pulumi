import { describe, expect, it } from 'vitest';
import type { InfrastructurePlan } from '@cloudforge/core';
import { buildProgram } from './build-program.js';

describe('buildProgram', () => {
  const plan: InfrastructurePlan = {
    providerKind: 'oracle',
    config: { region: 'eu-frankfurt-1' },
    resources: [
      { kind: 'network', name: 'vcn', cidrBlock: '10.0.0.0/16' },
      { kind: 'subnet', name: 'sub', networkName: 'vcn', cidrBlock: '10.0.1.0/24', public: true },
    ],
  };

  it('falls back to a metadata-only program when no credentials are supplied', async () => {
    const program = buildProgram(plan);
    const outputs = (await program()) as {
      providerKind: string;
      resourceCount: number;
      resources: { name: string; kind: string }[];
    };

    expect(outputs.providerKind).toBe('oracle');
    expect(outputs.resourceCount).toBe(2);
    expect(outputs.resources).toEqual([
      { name: 'vcn', kind: 'network' },
      { name: 'sub', kind: 'subnet' },
    ]);
  });

  it('falls back to metadata when Oracle credentials are incomplete', async () => {
    // Missing userOcid / fingerprint / privateKey — not enough to provision.
    const program = buildProgram(plan, { tenancyOcid: 'ocid1.tenancy', region: 'eu-frankfurt-1' });
    const outputs = (await program()) as { resourceCount: number };
    expect(outputs.resourceCount).toBe(2);
  });

  it('falls back to metadata when AWS credentials are incomplete', async () => {
    const awsPlan = { ...plan, providerKind: 'aws' };
    const program = buildProgram(awsPlan, { accessKeyId: 'AKIA', region: 'eu-west-1' });
    const outputs = (await program()) as { providerKind: string; resourceCount: number };
    expect(outputs).toMatchObject({ providerKind: 'aws', resourceCount: 2 });
  });
});
