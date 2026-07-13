import {
  type DeploymentError,
  err,
  newUuid,
  ok,
  type PersistenceError,
  type Result,
  toIsoDateString,
  ValidationError,
} from '@cloudforge/shared';
import type { DeployEventSink, Deployer, DeploymentTarget } from '../ports/deployer.js';
import type { DeploymentRecord, DeploymentRepository } from '../ports/deployment-repository.js';
import { type DeploymentDto, toDeploymentDto } from '../dto/deployment-dto.js';
import {
  type DeploymentContext,
  type DeploymentTemplateSummary,
  findTemplate,
  listTemplateSummaries,
} from './deployment-template.js';

/** Union of failures the deployment use-cases can surface. */
export type DeploymentServiceError = ValidationError | DeploymentError | PersistenceError;

/** Input for launching a deployment. */
export interface RunDeploymentInput {
  readonly projectId: string;
  readonly templateId: string;
  readonly target: DeploymentTarget;
  readonly context: DeploymentContext;
}

/**
 * Application service for the deployment pipeline: build steps from a template,
 * run them on the target host via the {@link Deployer}, and record the outcome.
 */
export class DeploymentService {
  constructor(
    private readonly deployer: Deployer,
    private readonly deployments: DeploymentRepository,
  ) {}

  listTemplates(): DeploymentTemplateSummary[] {
    return listTemplateSummaries();
  }

  async list(projectId: string): Promise<Result<DeploymentDto[], PersistenceError>> {
    const found = await this.deployments.listByProject(projectId);
    if (!found.ok) return found;
    return ok(found.value.map(toDeploymentDto));
  }

  count(): Promise<Result<number, PersistenceError>> {
    return this.deployments.countAll();
  }

  async run(
    input: RunDeploymentInput,
    onEvent?: DeployEventSink,
  ): Promise<Result<DeploymentDto, DeploymentServiceError>> {
    const template = findTemplate(input.templateId);
    if (!template) {
      return err(new ValidationError(`Unknown deployment template: ${input.templateId}`));
    }
    const steps = template.build(input.context);

    const now = toIsoDateString(new Date());
    const record: DeploymentRecord = {
      id: newUuid(),
      projectId: input.projectId,
      status: 'running',
      strategy: input.templateId,
      outputs: '{}',
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.deployments.create(record);
    if (!created.ok) return created;

    const outcome = await this.deployer.deploy(input.target, steps, onEvent);
    const finishedAt = toIsoDateString(new Date());
    const succeeded = outcome.ok && outcome.value.success;
    const outputs = JSON.stringify(outcome.ok ? outcome.value : { error: outcome.error.message });

    const updated = await this.deployments.update(record.id, {
      status: succeeded ? 'success' : 'failed',
      finishedAt,
      outputs,
    });
    if (!updated.ok) return updated;

    if (!outcome.ok) return err(outcome.error);
    return ok(
      toDeploymentDto({
        ...record,
        status: succeeded ? 'success' : 'failed',
        finishedAt,
        outputs,
      }),
    );
  }
}
