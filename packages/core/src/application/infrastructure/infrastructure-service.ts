import {
  err,
  type InfrastructureError,
  NotFoundError,
  ok,
  type PersistenceError,
  type Result,
} from '@cloudforge/shared';
import type {
  ApplyResult,
  EngineEventSink,
  InfrastructureEngine,
  PreviewResult,
  StackReference,
} from '../ports/infrastructure-engine.js';
import type { PlanStore } from '../ports/plan-store.js';
import { type InfrastructurePlan, type PlanIssue, validatePlan } from './infrastructure-plan.js';
import {
  findInfrastructureTemplate,
  type InfraTemplateContext,
  type InfrastructureTemplateSummary,
  listInfrastructureTemplateSummaries,
} from './infrastructure-template.js';

/**
 * Application service coordinating a project's infrastructure: it persists the
 * declarative plan and drives the {@link InfrastructureEngine} (preview / apply /
 * destroy / outputs). The renderer only ever talks to this service via IPC.
 */
export class InfrastructureService {
  constructor(
    private readonly engine: InfrastructureEngine,
    private readonly plans: PlanStore,
  ) {}

  /** Whether the underlying IaC engine is available on this host. */
  isEngineAvailable(): Promise<Result<boolean, InfrastructureError>> {
    return this.engine.isAvailable();
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

  async preview(
    ref: StackReference,
    projectId: string,
    onEvent?: EngineEventSink,
  ): Promise<Result<PreviewResult, InfrastructureError | PersistenceError | NotFoundError>> {
    const plan = await this.requirePlan(projectId);
    if (!plan.ok) return plan;
    return this.engine.preview(ref, plan.value, onEvent);
  }

  async apply(
    ref: StackReference,
    projectId: string,
    onEvent?: EngineEventSink,
  ): Promise<Result<ApplyResult, InfrastructureError | PersistenceError | NotFoundError>> {
    const plan = await this.requirePlan(projectId);
    if (!plan.ok) return plan;
    return this.engine.apply(ref, plan.value, onEvent);
  }

  destroy(
    ref: StackReference,
    onEvent?: EngineEventSink,
  ): Promise<Result<void, InfrastructureError>> {
    return this.engine.destroy(ref, onEvent);
  }

  outputs(ref: StackReference): Promise<Result<Record<string, unknown>, InfrastructureError>> {
    return this.engine.outputs(ref);
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
