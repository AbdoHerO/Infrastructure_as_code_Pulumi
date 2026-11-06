import {
  ConflictError,
  type DeploymentError,
  err,
  newUuid,
  NotFoundError,
  ok,
  ValidationError,
  type PersistenceError,
  type Result,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  CredentialService,
  CredentialServiceError,
} from '../credentials/credential-service.js';
import type { DomainPublisher } from '../domains/domain-publisher.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type {
  ComposeAnalysis,
  ComposeAnalyzer,
  StackEventSink,
  StackManager,
  StackRecord,
  StackRoute,
  StackRuntimeStatus,
  StackStore,
} from '../ports/stack-manager.js';
import {
  nextStackPort,
  renderStackOverride,
  validateStack,
  validateStackFiles,
  type StackInput,
} from './stack-definition.js';

export type StackServiceError =
  | ValidationError
  | NotFoundError
  | ConflictError
  | DeploymentError
  | PersistenceError
  | CredentialServiceError;

export interface StackFiles {
  readonly composeYaml: string;
  readonly environment: string;
}

/** Applications behind a domain can be slow, e.g. an upload or a long report. */
const PROXY_TIMEOUT_SECONDS = 300;

function secretName(name: string): string {
  return `Docker stack · ${name}`;
}

/**
 * Deploys any Docker Compose stack on a server and publishes it on domains.
 *
 * The user's Compose file and `.env` stay exactly as written; CloudForge adds a
 * second Compose file for the local ports and labels. DNS, Nginx and HTTPS are
 * the {@link DomainPublisher}'s job, the same as for WordPress sites.
 */
export class StackService {
  constructor(
    private readonly store: StackStore,
    private readonly targets: RemoteTargetResolver,
    private readonly manager: StackManager,
    private readonly analyzer: ComposeAnalyzer,
    private readonly credentials: Pick<
      CredentialService,
      'create' | 'update' | 'list' | 'getDecrypted' | 'remove'
    >,
    private readonly activities: Pick<ActivityService, 'recordSafe'>,
    private readonly domains: Pick<DomainPublisher, 'check' | 'publish' | 'unpublish'>,
  ) {}

  list(): Promise<Result<StackRecord[], PersistenceError>> {
    return this.store.list();
  }

  analyze(composeYaml: string, environment: string): ComposeAnalysis {
    return this.analyzer.analyze(composeYaml, environment);
  }

  /**
   * Create a stack and run every step. Nothing touches the server until every
   * domain has been checked. A failure after that keeps the record (status
   * `failed`), so Redeploy or Remove can finish the job.
   */
  async create(
    input: StackInput,
    onEvent?: StackEventSink,
  ): Promise<Result<StackRecord, StackServiceError>> {
    const analysis = this.analyzer.analyze(input.composeYaml, input.environment);
    const valid = validateStack(input, analysis);
    if (!valid.ok) return valid;
    const stacks = await this.store.list();
    if (!stacks.ok) return stacks;
    if (
      stacks.value.some(
        (stack) => stack.name === valid.value.name && stack.targetId === valid.value.targetId,
      )
    )
      return err(new ConflictError(`A stack named ${valid.value.name} already exists`));

    // Before anything is written: a taken domain must block the whole deploy.
    for (const route of valid.value.routes) {
      const checked = await this.domains.check({
        targetId: valid.value.targetId,
        domain: route.domain,
        cloudflareCredentialId: route.cloudflareCredentialId,
        cloudflareZoneId: route.cloudflareZoneId,
      });
      if (!checked.ok) return checked;
      if (!checked.value.available)
        return err(new ConflictError(checked.value.conflicts.join(' ')));
    }

    const target = await this.targets.resolve(valid.value.targetId);
    if (!target.ok) return target;
    const routes = await this.assignPorts(
      valid.value.routes,
      valid.value.targetId,
      stacks.value,
      target.value,
    );
    if (!routes.ok) return routes;

    const credentialId = await this.saveFiles(valid.value.name, {
      composeYaml: valid.value.composeYaml,
      environment: valid.value.environment,
    });
    if (!credentialId.ok) return credentialId;

    const now = new Date().toISOString();
    const record: StackRecord = {
      id: newUuid(),
      targetId: valid.value.targetId,
      name: valid.value.name,
      credentialId: credentialId.value,
      routes: routes.value,
      certificateEmail: valid.value.certificateEmail,
      services: analysis.services.map((service) => service.name),
      externalNetworks: analysis.externalNetworks,
      externalVolumes: analysis.externalVolumes,
      status: 'deploying',
      warnings: [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await this.store.save(record);
    if (!saved.ok) return saved;
    const applied = await this.apply(record, valid.value, analysis, onEvent);
    if (!applied.ok) return applied;
    this.activities.recordSafe({
      type: 'stack.created',
      message: `Deployed the Docker stack ${record.name}`,
      metadata: {
        stackId: record.id,
        targetId: record.targetId,
        domains: record.routes.map((route) => route.domain),
      },
    });
    return ok(applied.value);
  }

  /** The stack's Compose file and `.env`, on explicit request, to edit them. */
  async reveal(id: string): Promise<Result<StackFiles, StackServiceError>> {
    const stack = await this.load(id);
    if (!stack.ok) return stack;
    return this.readFiles(stack.value);
  }

  /** Save an edited Compose file or `.env`, then deploy them. */
  async update(
    id: string,
    files: StackFiles,
    onEvent?: StackEventSink,
  ): Promise<Result<StackRecord, StackServiceError>> {
    const stack = await this.load(id);
    if (!stack.ok) return stack;
    const analysis = this.analyzer.analyze(files.composeYaml, files.environment);
    const valid = validateStackFiles(files.composeYaml, files.environment, analysis);
    if (!valid.ok) return valid;
    for (const route of stack.value.routes) {
      if (!analysis.services.some((service) => service.name === route.service))
        return err(
          new ValidationError(
            `${route.domain} goes to the service "${route.service}", which is no longer in the Compose file`,
          ),
        );
    }
    const saved = await this.saveFiles(stack.value.name, files);
    if (!saved.ok) return saved;
    const applied = await this.apply(
      { ...stack.value, credentialId: saved.value },
      files,
      analysis,
      onEvent,
    );
    if (applied.ok) {
      this.activities.recordSafe({
        type: 'stack.updated',
        message: `Updated the Docker stack "${stack.value.name}"`,
        metadata: { stackId: id },
      });
    }
    return applied;
  }

  /** Pull the latest images and run every step again; safe on a working stack. */
  async redeploy(
    id: string,
    onEvent?: StackEventSink,
  ): Promise<Result<StackRecord, StackServiceError>> {
    const stack = await this.load(id);
    if (!stack.ok) return stack;
    const files = await this.readFiles(stack.value);
    if (!files.ok) return files;
    const analysis = this.analyzer.analyze(files.value.composeYaml, files.value.environment);
    if (analysis.errors.length > 0)
      return this.fail(stack.value, new ValidationError(analysis.errors.join(' ')));
    const applied = await this.apply(stack.value, files.value, analysis, onEvent);
    if (applied.ok) {
      this.activities.recordSafe({
        type: 'stack.redeployed',
        message: `Redeployed the Docker stack "${stack.value.name}"`,
        metadata: { stackId: id },
      });
    }
    return applied;
  }

  async status(id: string): Promise<Result<StackRuntimeStatus, StackServiceError>> {
    const stack = await this.load(id);
    if (!stack.ok) return stack;
    const target = await this.targets.resolve(stack.value.targetId);
    if (!target.ok) return target;
    return this.manager.status(
      target.value,
      stack.value.name,
      stack.value.routes.map((route) => route.hostPort),
    );
  }

  /**
   * Remove the containers and the Nginx sites. Without `deleteData` the volumes,
   * the server files, the DNS records and the saved files stay, so deploying
   * the same name again brings the stack back. With it they go too, except
   * external volumes and networks: other stacks may use those.
   */
  async remove(
    id: string,
    deleteData: boolean,
    onEvent?: StackEventSink,
  ): Promise<Result<{ warnings: string[] }, StackServiceError>> {
    const stack = await this.load(id);
    if (!stack.ok) return stack;
    const target = await this.targets.resolve(stack.value.targetId);
    if (!target.ok) return target;
    const removed = await this.manager.remove(target.value, stack.value.name, deleteData, onEvent);
    if (!removed.ok) return removed;
    const warnings: string[] = [];
    for (const route of stack.value.routes) {
      const unpublished = await this.domains.unpublish(
        {
          targetId: stack.value.targetId,
          domain: route.domain,
          cloudflareCredentialId: route.cloudflareCredentialId,
          cloudflareZoneId: route.cloudflareZoneId,
        },
        { deleteDns: deleteData },
        onEvent,
      );
      if (!unpublished.ok) return unpublished;
      warnings.push(...unpublished.value.warnings);
    }
    if (deleteData) await this.credentials.remove(stack.value.credentialId);
    const deleted = await this.store.remove(id);
    if (!deleted.ok) return deleted;
    this.activities.recordSafe({
      type: 'stack.removed',
      message: `Removed the Docker stack ${stack.value.name}${deleteData ? ' and its data' : ''}`,
      metadata: { stackId: id, targetId: stack.value.targetId, deleteData },
    });
    return ok({ warnings });
  }

  private async apply(
    stack: StackRecord,
    files: StackFiles,
    analysis: ComposeAnalysis,
    onEvent?: StackEventSink,
  ): Promise<Result<StackRecord, StackServiceError>> {
    const step = (message: string): void => onEvent?.({ stream: 'step', message });
    const target = await this.targets.resolve(stack.targetId);
    if (!target.ok) return this.fail(stack, target.error);
    const services = analysis.services.map((service) => service.name);

    step(`Deploying the stack ${stack.name}`);
    const deployed = await this.manager.deploy(
      target.value,
      {
        project: stack.name,
        composeYaml: files.composeYaml,
        environment: files.environment,
        overrideYaml: renderStackOverride({ name: stack.name, services, routes: stack.routes }),
        externalNetworks: analysis.externalNetworks,
        externalVolumes: analysis.externalVolumes,
        containerNames: analysis.services.flatMap((service) =>
          service.containerName ? [service.containerName] : [],
        ),
        hostPorts: stack.routes.map((route) => route.hostPort),
      },
      onEvent,
    );
    if (!deployed.ok) return this.fail(stack, deployed.error);

    const warnings = runtimeWarnings(stack.routes, deployed.value);
    for (const route of stack.routes) {
      const published = await this.domains.publish(
        {
          targetId: stack.targetId,
          domain: route.domain,
          hostPort: route.hostPort,
          cloudflareCredentialId: route.cloudflareCredentialId,
          cloudflareZoneId: route.cloudflareZoneId,
          proxied: route.proxied,
          https: route.https,
          certificateEmail: stack.certificateEmail,
          clientMaxBodySize: route.clientMaxBodySize,
          proxyTimeoutSeconds: PROXY_TIMEOUT_SECONDS,
          websocket: true,
        },
        onEvent,
      );
      if (!published.ok) return this.fail(stack, published.error);
      warnings.push(...published.value.warnings);
    }

    const record: StackRecord = {
      ...stack,
      services,
      externalNetworks: analysis.externalNetworks,
      externalVolumes: analysis.externalVolumes,
      status: 'running',
      warnings,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.store.save(record);
    if (!saved.ok) return saved;
    step(
      warnings.length === 0
        ? `The stack ${stack.name} is running`
        : `The stack ${stack.name} is running with ${String(warnings.length)} warning${warnings.length === 1 ? '' : 's'}`,
    );
    return ok(record);
  }

  /** Give each route a local port that nothing on the server uses. */
  private async assignPorts(
    routes: readonly (Omit<StackRoute, 'hostPort'> & { hostPort: number | null })[],
    targetId: string,
    stacks: readonly StackRecord[],
    target: DeploymentTarget,
  ): Promise<Result<StackRoute[], StackServiceError>> {
    if (routes.length === 0) return ok([]);
    const used = await this.manager.usedPorts(target);
    if (!used.ok) return used;
    const taken = new Set<number>(used.value);
    for (const stack of stacks)
      if (stack.targetId === targetId) for (const route of stack.routes) taken.add(route.hostPort);
    const assigned: StackRoute[] = [];
    for (const route of routes) {
      if (route.hostPort !== null && taken.has(route.hostPort))
        return err(
          new ConflictError(
            `Port ${String(route.hostPort)} is already used on this server. Choose another one for ${route.domain}.`,
          ),
        );
      const hostPort = route.hostPort ?? nextStackPort(taken);
      taken.add(hostPort);
      assigned.push({ ...route, hostPort });
    }
    return ok(assigned);
  }

  /** Create or replace the encrypted secret holding the file and `.env`; returns its id. */
  private async saveFiles(
    name: string,
    files: StackFiles,
  ): Promise<Result<string, StackServiceError>> {
    const listed = await this.credentials.list();
    if (!listed.ok) return listed;
    // Remove keeps this secret, so a stack deployed again replaces it.
    const existing = listed.value.find(
      (credential) => credential.kind === 'docker-stack' && credential.name === secretName(name),
    );
    const input = {
      kind: 'docker-stack',
      name: secretName(name),
      data: { composeYaml: files.composeYaml, environment: files.environment },
    };
    const saved = existing
      ? await this.credentials.update({ id: existing.id, ...input })
      : await this.credentials.create(input);
    return saved.ok ? ok(saved.value.id) : saved;
  }

  private async readFiles(stack: StackRecord): Promise<Result<StackFiles, StackServiceError>> {
    const credential = await this.credentials.getDecrypted(stack.credentialId);
    if (!credential.ok)
      return err(
        new NotFoundError(`The files of the stack ${stack.name} are missing from Secrets`, {
          cause: credential.error,
        }),
      );
    return ok({
      composeYaml: credential.value.data.composeYaml ?? '',
      environment: credential.value.data.environment ?? '',
    });
  }

  private async load(id: string): Promise<Result<StackRecord, StackServiceError>> {
    const stacks = await this.store.list();
    if (!stacks.ok) return stacks;
    const stack = stacks.value.find((item) => item.id === id);
    return stack ? ok(stack) : err(new NotFoundError('This stack no longer exists'));
  }

  private async fail(
    stack: StackRecord,
    cause: StackServiceError,
  ): Promise<Result<never, StackServiceError>> {
    await this.store.save({
      ...stack,
      status: 'failed',
      lastError: cause.message,
      updatedAt: new Date().toISOString(),
    });
    this.activities.recordSafe({
      type: 'stack.failed',
      message: `The Docker stack ${stack.name} failed: ${cause.message}`,
      metadata: { stackId: stack.id, targetId: stack.targetId },
    });
    return err(cause);
  }
}

/** Containers that are not healthy and routes nothing answers on. */
function runtimeWarnings(routes: readonly StackRoute[], status: StackRuntimeStatus): string[] {
  const warnings: string[] = [];
  for (const container of status.containers) {
    if (container.state !== 'running')
      warnings.push(`The container ${container.name} is ${container.state}, not running.`);
    else if (container.health === 'unhealthy')
      warnings.push(`The container ${container.name} is running but unhealthy.`);
  }
  for (const route of routes) {
    const port = status.ports.find((item) => item.port === route.hostPort);
    if (port?.state === 'closed')
      warnings.push(
        `Nothing answered on port ${String(route.containerPort)} of the service ${route.service}, so ${route.domain} may show an error. Check the port the application listens on. To change it, use Remove (your data stays) and deploy again with the right port.`,
      );
  }
  return warnings;
}
