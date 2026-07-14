import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { InfrastructureEngine } from '../ports/infrastructure-engine.js';
import type { PlanStore } from '../ports/plan-store.js';
import type { ProviderCredentialResolver } from '../ports/provider-credential-resolver.js';
import type { TemplateStore } from '../ports/template-store.js';
import type { InfrastructurePlan } from './infrastructure-plan.js';
import { InfrastructureService } from './infrastructure-service.js';

const ref = { project: 'project-123', stack: 'development' };
const initialPlan: InfrastructurePlan = {
  providerKind: 'oracle',
  config: { region: 'eu-frankfurt-1' },
  resources: [{ kind: 'network', name: 'network', cidrBlock: '10.0.0.0/16' }],
};

function fixture(): {
  service: InfrastructureService;
  setPlan(plan: InfrastructurePlan): void;
  apply: ReturnType<typeof vi.fn>;
} {
  let plan = initialPlan;
  const apply = vi.fn().mockResolvedValue(ok({ outputs: {}, summary: 'succeeded' }));
  const engine = {
    preview: vi.fn().mockResolvedValue(
      ok({
        changes: { update: 1 },
        resources: [
          {
            urn: 'urn::network',
            name: 'network',
            type: 'Vcn',
            operation: 'update',
            destructive: false,
            changedProperties: ['cidrBlocks'],
            replacementProperties: [],
          },
        ],
        hasReplacements: false,
        hasDeletes: false,
      }),
    ),
    apply,
  } as unknown as InfrastructureEngine;
  const plans = {
    load: vi.fn().mockImplementation(() => Promise.resolve(ok(plan))),
    save: vi.fn().mockImplementation((_projectId: string, next: InfrastructurePlan) => {
      plan = next;
      return Promise.resolve(ok(undefined));
    }),
  } as unknown as PlanStore;
  const credentials = {
    forProject: vi.fn().mockResolvedValue(ok({ region: 'eu-frankfurt-1' })),
  } as ProviderCredentialResolver;
  const templates = {} as TemplateStore;
  return {
    service: new InfrastructureService(engine, plans, credentials, templates),
    setPlan: (next) => {
      plan = next;
    },
    apply,
  };
}

describe('InfrastructureService safe apply', () => {
  it('requires a preview token and consumes it after a successful apply', async () => {
    const { service, apply } = fixture();
    const rejected = await service.apply(ref, 'project-id', '');
    expect(rejected.ok).toBe(false);

    const preview = await service.preview(ref, 'project-id');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.resources[0]?.operation).toBe('update');

    const applied = await service.apply(ref, 'project-id', preview.value.previewToken);
    expect(applied.ok).toBe(true);
    expect(apply.mock.calls).toHaveLength(1);

    const reused = await service.apply(ref, 'project-id', preview.value.previewToken);
    expect(reused.ok).toBe(false);
  });

  it('rejects apply when the saved plan changed after preview', async () => {
    const subject = fixture();
    const preview = await subject.service.preview(ref, 'project-id');
    if (!preview.ok) throw preview.error;
    subject.setPlan({ ...initialPlan, config: { region: 'uk-london-1' } });

    const result = await subject.service.apply(ref, 'project-id', preview.value.previewToken);

    expect(result.ok).toBe(false);
    expect(subject.apply.mock.calls).toHaveLength(0);
  });
});
