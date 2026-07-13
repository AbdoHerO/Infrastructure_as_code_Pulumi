import type { PulumiFn } from '@pulumi/pulumi/automation';
import type { InfrastructurePlan } from '@cloudforge/core';

/**
 * Compile a declarative {@link InfrastructurePlan} into a Pulumi inline program.
 *
 * Phase 6 establishes the engine and produces a valid program that surfaces the
 * plan as stack outputs (no cloud resources yet, so it runs with only the Pulumi
 * CLI + local backend). Phase 7 extends this interpreter to emit real
 * provider resources (compute, network, firewall, volume, …).
 */
export function buildProgram(plan: InfrastructurePlan): PulumiFn {
  return () =>
    Promise.resolve({
      providerKind: plan.providerKind,
      resourceCount: plan.resources.length,
      resources: plan.resources.map((resource) => ({ name: resource.name, kind: resource.kind })),
    });
}
