import { describe, expect, it } from 'vitest';
import type { InfrastructurePlan } from '@cloudforge/core';
import { buildProgram } from './build-program.js';

describe('buildProgram', () => {
  it('produces a program that surfaces the plan as outputs', async () => {
    const plan: InfrastructurePlan = {
      providerKind: 'oracle',
      config: { region: 'eu-frankfurt-1' },
      resources: [
        { kind: 'network', name: 'vcn', cidrBlock: '10.0.0.0/16' },
        { kind: 'subnet', name: 'sub', networkName: 'vcn', cidrBlock: '10.0.1.0/24', public: true },
      ],
    };

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
});
