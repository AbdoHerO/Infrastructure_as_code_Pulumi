import {
  DeploymentError,
  err,
  newUuid,
  ok,
  type PersistenceError,
  type Result,
  toIsoDateString,
  ValidationError,
} from '@cloudforge/shared';
import type {
  DeployEventSink,
  Deployer,
  DeploymentOptions,
  DeploymentTarget,
} from '../ports/deployer.js';
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

const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/i;
const IMAGE_PATTERN =
  /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*(?::[a-zA-Z0-9._-]{1,128}|@sha256:[a-fA-F0-9]{64})?$/;

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

  inspectHostKey(host: string, port: number): Promise<Result<string, DeploymentError>> {
    const issue = validateConnection(host, port, 'cloudforge', undefined);
    if (issue) return Promise.resolve(err(new DeploymentError(issue)));
    return this.deployer.inspectHostKey(normalizeHost(host), port);
  }

  recoverInterrupted(): Promise<Result<number, PersistenceError>> {
    return this.deployments.failRunning(
      'CloudForge exited before the deployment completed',
      toIsoDateString(new Date()),
    );
  }

  async run(
    input: RunDeploymentInput,
    onEvent?: DeployEventSink,
    options?: DeploymentOptions,
  ): Promise<Result<DeploymentDto, DeploymentServiceError>> {
    const template = findTemplate(input.templateId);
    if (!template) {
      return err(new ValidationError(`Unknown deployment template: ${input.templateId}`));
    }
    const validationIssue = validateConnection(
      input.target.host,
      input.target.port,
      input.target.username,
      input.context.appImage,
    );
    if (validationIssue) return err(new ValidationError(validationIssue));
    if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(normalizeFingerprint(input.target.hostKeySha256))) {
      return err(new ValidationError('Inspect and trust a valid SHA-256 SSH host fingerprint'));
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

    const outcome = await this.deployer.deploy(
      {
        ...input.target,
        host: normalizeHost(input.target.host),
        hostKeySha256: normalizeFingerprint(input.target.hostKeySha256),
      },
      steps,
      onEvent,
      options,
    );
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

function validateConnection(
  host: string,
  port: number,
  username: string,
  appImage: string | undefined,
): string | null {
  if (!HOST_PATTERN.test(host.trim())) return 'Enter a valid hostname or IP address';
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'SSH port must be 1–65535';
  if (!USER_PATTERN.test(username)) return 'SSH username contains unsupported characters';
  if (appImage && !IMAGE_PATTERN.test(appImage)) return 'Container image reference is invalid';
  return null;
}

function normalizeHost(host: string): string {
  const value = host.trim();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function normalizeFingerprint(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('SHA256:') ? trimmed : `SHA256:${trimmed}`;
}
