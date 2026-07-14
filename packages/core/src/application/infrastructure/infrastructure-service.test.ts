import { describe, expect, it, vi } from 'vitest';
import { err, InfrastructureError, ok } from '@cloudforge/shared';
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
  setCredentialProvider(providerKind: 'oracle' | 'aws'): void;
  preview: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  deletePlan: ReturnType<typeof vi.fn>;
} {
  let plan: InfrastructurePlan | null = initialPlan;
  let credentialProvider: 'oracle' | 'aws' = 'oracle';
  const apply = vi.fn().mockResolvedValue(ok({ outputs: {}, summary: 'succeeded' }));
  const destroy = vi.fn().mockResolvedValue(ok(undefined));
  const deletePlan = vi.fn().mockImplementation(() => {
    plan = null;
    return Promise.resolve(ok(undefined));
  });
  const preview = vi.fn().mockResolvedValue(
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
  );
  const engine = {
    preview,
    apply,
    destroy,
  } as unknown as InfrastructureEngine;
  const plans = {
    load: vi.fn().mockImplementation(() => Promise.resolve(ok(plan))),
    save: vi.fn().mockImplementation((_projectId: string, next: InfrastructurePlan) => {
      plan = next;
      return Promise.resolve(ok(undefined));
    }),
    delete: deletePlan,
  } as unknown as PlanStore;
  const credentials = {
    forProject: vi.fn().mockImplementation(() =>
      Promise.resolve(
        ok({
          providerKind: credentialProvider,
          data:
            credentialProvider === 'aws'
              ? { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', region: 'eu-west-1' }
              : { region: 'eu-frankfurt-1' },
        }),
      ),
    ),
  } as ProviderCredentialResolver;
  const templates = {} as TemplateStore;
  return {
    service: new InfrastructureService(engine, plans, credentials, templates),
    setPlan: (next) => {
      plan = next;
    },
    setCredentialProvider: (next) => {
      credentialProvider = next;
    },
    preview,
    apply,
    destroy,
    deletePlan,
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

  it('rejects a plan whose provider does not match the linked credential', async () => {
    const subject = fixture();
    subject.setPlan({ ...initialPlan, providerKind: 'aws' });

    const result = await subject.service.preview(ref, 'project-id');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('linked to oracle');
  });

  it('previews and applies an AWS plan with only the linked AWS credential data', async () => {
    const subject = fixture();
    const awsPlan = { ...initialPlan, providerKind: 'aws' };
    subject.setPlan(awsPlan);
    subject.setCredentialProvider('aws');

    const preview = await subject.service.preview(ref, 'project-id');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(subject.preview).toHaveBeenCalledWith(
      ref,
      awsPlan,
      { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', region: 'eu-west-1' },
      undefined,
    );

    const applied = await subject.service.apply(ref, 'project-id', preview.value.previewToken);
    expect(applied.ok).toBe(true);
    expect(subject.apply).toHaveBeenCalledWith(
      ref,
      awsPlan,
      { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', region: 'eu-west-1' },
      undefined,
    );
  });
});

describe('InfrastructureService destroy cleanup', () => {
  it('deletes the persisted project plan after the cloud stack is destroyed', async () => {
    const subject = fixture();

    const result = await subject.service.destroy(ref, 'project-id');

    expect(result.ok).toBe(true);
    expect(subject.destroy).toHaveBeenCalledWith(ref, undefined);
    expect(subject.deletePlan).toHaveBeenCalledWith('project-id');
    await expect(subject.service.getPlan('project-id')).resolves.toEqual(ok(null));
  });

  it('preserves the persisted plan when cloud destruction fails', async () => {
    const subject = fixture();
    subject.destroy.mockResolvedValueOnce(err(new InfrastructureError('Cloud destruction failed')));

    const result = await subject.service.destroy(ref, 'project-id');

    expect(result.ok).toBe(false);
    expect(subject.deletePlan).not.toHaveBeenCalled();
    await expect(subject.service.getPlan('project-id')).resolves.toEqual(ok(initialPlan));
  });
});
