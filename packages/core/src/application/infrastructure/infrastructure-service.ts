import {
  err,
  InfrastructureError,
  newUuid,
  NotFoundError,
  ok,
  type PersistenceError,
  type Result,
  ValidationError,
} from '@cloudforge/shared';
import type {
  ApplyResult,
  EngineEventSink,
  InfrastructureEngine,
  ManagedStackSummary,
  PreviewAnalysis,
  PreviewResult,
  StackReference,
} from '../ports/infrastructure-engine.js';
import type { PlanStore } from '../ports/plan-store.js';
import type { ProviderCredentialResolver } from '../ports/provider-credential-resolver.js';
import type {
  CustomTemplate,
  CustomTemplateSummary,
  TemplateStore,
} from '../ports/template-store.js';
import { type InfrastructurePlan, type PlanIssue, validatePlan } from './infrastructure-plan.js';
import {
  findInfrastructureTemplate,
  type InfraTemplateContext,
  type InfrastructureTemplateSummary,
  listInfrastructureTemplateSummaries,
} from './infrastructure-template.js';
import type { ManagedVpsTargetSyncService } from '../vps-targets/managed-vps-target-sync-service.js';

/**
 * Application service coordinating a project's infrastructure: it persists the
 * declarative plan and drives the {@link InfrastructureEngine} (preview / apply /
 * destroy / outputs). The renderer only ever talks to this service via IPC.
 */
export class InfrastructureService {
  private readonly previews = new Map<string, { token: string; planFingerprint: string }>();

  constructor(
    private readonly engine: InfrastructureEngine,
    private readonly plans: PlanStore,
    private readonly credentials: ProviderCredentialResolver,
    private readonly templates: TemplateStore,
    private readonly targetSync?: ManagedVpsTargetSyncService,
  ) {}

  /** Whether the underlying IaC engine is available on this host. */
  isEngineAvailable(): Promise<Result<boolean, InfrastructureError>> {
    return this.engine.isAvailable();
  }

  /** All stacks tracked by CloudForge's private Pulumi backend. */
  listManagedStacks(): Promise<Result<ManagedStackSummary[], InfrastructureError>> {
    return this.engine.listManagedStacks();
  }

  /** Destroy a discovered stack, including one whose database project is gone. */
  async destroyManagedStack(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    const stacks = await this.engine.listManagedStacks();
    if (!stacks.ok) return stacks;
    const exists = stacks.value.some(
      (stack) => stack.ref.project === ref.project && stack.ref.stack === ref.stack,
    );
    if (!exists) {
      return err(
        new InfrastructureError('Managed stack not found', {
          context: { project: ref.project, stack: ref.stack },
        }),
      );
    }
    return this.engine.destroy(ref, onEvent);
  }

  getPlan(projectId: string): Promise<Result<InfrastructurePlan | null, PersistenceError>> {
    return this.plans.load(projectId);
  }

  savePlan(projectId: string, plan: InfrastructurePlan): Promise<Result<void, PersistenceError>> {
    return this.plans.save(projectId, plan);
  }

  /** Validate a plan's internal consistency (pure). */
  validate(plan: InfrastructurePlan): PlanIssue[] {
    return validatePlan(plan);
  }

  /** The built-in infrastructure templates. */
  listTemplates(): InfrastructureTemplateSummary[] {
    return listInfrastructureTemplateSummaries();
  }

  /** Generate a plan from a template and persist it for a project. */
  async applyTemplate(
    projectId: string,
    templateId: string,
    context: InfraTemplateContext,
  ): Promise<Result<InfrastructurePlan, PersistenceError | NotFoundError>> {
    const template = findInfrastructureTemplate(templateId);
    if (!template) {
      return err(new NotFoundError(`Unknown infrastructure template: ${templateId}`));
    }
    const plan = template.build(context);
    const saved = await this.plans.save(projectId, plan);
    if (!saved.ok) return saved;
    return ok(plan);
  }

  /** List user-saved (custom) infrastructure templates. */
  listCustomTemplates(): Promise<Result<CustomTemplateSummary[], PersistenceError>> {
    return this.templates.list();
  }

  /** Save the given plan as a reusable custom template. */
  async saveCustomTemplate(input: {
    name: string;
    description?: string;
    plan: InfrastructurePlan;
  }): Promise<Result<CustomTemplateSummary, ValidationError | PersistenceError>> {
    const name = input.name.trim();
    if (name.length === 0) return err(new ValidationError('Template name is required'));
    const template: CustomTemplate = {
      id: newUuid(),
      name,
      description: input.description?.trim() ?? '',
      plan: input.plan,
    };
    const saved = await this.templates.save(template);
    if (!saved.ok) return saved;
    return ok({ id: template.id, name: template.name, description: template.description });
  }

  /** Delete a custom template. */
  deleteCustomTemplate(id: string): Promise<Result<void, PersistenceError>> {
    return this.templates.delete(id);
  }

  /** Apply a custom template's stored plan to a project, persisting it. */
  async applyCustomTemplate(
    projectId: string,
    templateId: string,
  ): Promise<Result<InfrastructurePlan, PersistenceError | NotFoundError>> {
    const template = await this.templates.get(templateId);
    if (!template.ok) return template;
    if (template.value === null) {
      return err(new NotFoundError('Custom template not found', { context: { templateId } }));
    }
    const saved = await this.plans.save(projectId, template.value.plan);
    if (!saved.ok) return saved;
    return ok(template.value.plan);
  }

  async preview(
    ref: StackReference,
    projectId: string,
    onEvent?: EngineEventSink,
  ): Promise<Result<PreviewResult, InfrastructureError | PersistenceError | NotFoundError>> {
    const plan = await this.requirePlan(projectId);
    if (!plan.ok) return plan;
    const credentials = await this.credentials.forProject(projectId);
    if (!credentials.ok) return credentials;
    if (credentials.value.providerKind !== plan.value.providerKind) {
      return err(
        new InfrastructureError(
          `The saved plan targets ${plan.value.providerKind}, but this project is linked to ${credentials.value.providerKind}. Apply a matching template or link the correct provider credential.`,
        ),
      );
    }
    const preview = await this.engine.preview(ref, plan.value, credentials.value.data, onEvent);
    if (!preview.ok) return preview;
    const token = newUuid();
    this.previews.set(stackKey(ref), { token, planFingerprint: fingerprint(plan.value) });
    return ok(toPreviewResult(preview.value, token));
  }

  async apply(
    ref: StackReference,
    projectId: string,
    previewToken: string,
    onEvent?: EngineEventSink,
  ): Promise<
    Result<ApplyResult, InfrastructureError | PersistenceError | NotFoundError | ValidationError>
  > {
    const plan = await this.requirePlan(projectId);
    if (!plan.ok) return plan;
    const approved = this.previews.get(stackKey(ref));
    if (
      !previewToken ||
      approved?.token !== previewToken ||
      approved?.planFingerprint !== fingerprint(plan.value)
    ) {
      return err(
        new ValidationError(
          'Run Preview for the current saved plan before Apply. The plan changed or the preview expired.',
        ),
      );
    }
    const credentials = await this.credentials.forProject(projectId);
    if (!credentials.ok) return credentials;
    if (credentials.value.providerKind !== plan.value.providerKind) {
      return err(
        new InfrastructureError(
          `The saved plan targets ${plan.value.providerKind}, but this project is linked to ${credentials.value.providerKind}. Apply a matching template or link the correct provider credential.`,
        ),
      );
    }
    const applied = await this.engine.apply(ref, plan.value, credentials.value.data, onEvent);
    if (!applied.ok) return applied;
    this.previews.delete(stackKey(ref));
    const synchronized = this.targetSync
      ? await this.targetSync.sync(projectId, plan.value, applied.value.outputs, onEvent)
      : { targets: [], warnings: [] };
    for (const warning of synchronized.warnings) {
      onEvent?.({ stream: 'stderr', message: `VPS target synchronization: ${warning}` });
    }
    return ok({
      ...applied.value,
      targetSync: { count: synchronized.targets.length, warnings: synchronized.warnings },
    });
  }

  async destroy(
    ref: StackReference,
    projectId: string,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError | PersistenceError>> {
    const destroyed = await this.engine.destroy(ref, onEvent);
    if (!destroyed.ok) return destroyed;

    const targetWarnings = this.targetSync ? await this.targetSync.removeProject(projectId) : [];
    for (const warning of targetWarnings) {
      onEvent?.({ stream: 'stderr', message: `VPS target cleanup: ${warning}` });
    }

    const deleted = await this.plans.delete(projectId);
    if (deleted.ok) this.previews.delete(stackKey(ref));
    return deleted;
  }

  refresh(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    return this.engine.refresh(ref, onEvent);
  }

  async outputs(
    ref: StackReference,
    projectId?: string,
    onEvent?: EngineEventSink,
  ): Promise<Result<Record<string, unknown>, InfrastructureError>> {
    const outputs = await this.engine.outputs(ref);
    if (!outputs.ok || !projectId || !this.targetSync) return outputs;
    const plan = await this.plans.load(projectId);
    if (!plan.ok || !plan.value) return outputs;
    const synchronized = await this.targetSync.sync(projectId, plan.value, outputs.value, onEvent);
    for (const warning of synchronized.warnings) {
      onEvent?.({ stream: 'stderr', message: `VPS target synchronization: ${warning}` });
    }
    return outputs;
  }

  private async requirePlan(
    projectId: string,
  ): Promise<Result<InfrastructurePlan, PersistenceError | NotFoundError>> {
    const plan = await this.plans.load(projectId);
    if (!plan.ok) return plan;
    if (plan.value === null) {
      return err(
        new NotFoundError('No infrastructure plan for this project', { context: { projectId } }),
      );
    }
    return ok(plan.value);
  }
}

function stackKey(ref: StackReference): string {
  return `${ref.project}/${ref.stack}`;
}

function fingerprint(plan: InfrastructurePlan): string {
  return JSON.stringify(plan);
}

function toPreviewResult(analysis: PreviewAnalysis, previewToken: string): PreviewResult {
  return { ...analysis, previewToken };
}
