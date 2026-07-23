import {
  DeploymentError,
  err,
  newUuid,
  NotFoundError,
  ok,
  toIsoDateString,
  ValidationError,
  type PersistenceError,
  type Result,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  CredentialService,
  CredentialServiceError,
} from '../credentials/credential-service.js';
import type { NginxService } from '../nginx/nginx-service.js';
import type { NginxLocation } from '../ports/nginx-manager.js';
import type { ManagedDnsCoordinator } from '../ports/certificate-manager.js';
import type {
  JenkinsConnection,
  JenkinsJobStatus,
  JenkinsManager,
  JenkinsParameter,
} from '../ports/jenkins-manager.js';
import type {
  JenkinsPipelineRecord,
  JenkinsPipelineRepository,
  JenkinsApplicationRoute,
} from '../ports/jenkins-pipeline-repository.js';
import type { VpsTargetService } from '../vps-targets/vps-target-service.js';

export interface SaveJenkinsPipelineInput {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly targetId: string;
  readonly jenkinsCredentialId: string;
  readonly repositoryAccess?: 'public' | 'private';
  readonly githubCredentialId?: string | null;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly jenkinsfilePath: string;
  readonly pipelineScript: string;
  readonly definitionMode: 'scm' | 'inline';
  readonly parameters: readonly JenkinsParameter[];
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentCredentialId?: string | null;
  readonly domain: string;
  readonly applicationPort?: number | null;
  readonly cloudflareCredentialId?: string | null;
  readonly cloudflareZoneId?: string | null;
  readonly configureDomain: boolean;
  readonly applicationRoutes?: readonly JenkinsApplicationRoute[];
}

export type JenkinsPipelineServiceError =
  ValidationError | NotFoundError | PersistenceError | DeploymentError | CredentialServiceError;

export class JenkinsPipelineService {
  constructor(
    private readonly pipelines: JenkinsPipelineRepository,
    private readonly targets: VpsTargetService,
    private readonly credentials: CredentialService,
    private readonly jenkins: JenkinsManager,
    private readonly activities: ActivityService,
    private readonly managedDns?: ManagedDnsCoordinator,
    private readonly nginx?: NginxService,
  ) {}

  list(): Promise<Result<JenkinsPipelineRecord[], PersistenceError>> {
    return this.pipelines.list();
  }

  async test(
    targetId: string,
    credentialId: string,
  ): Promise<Result<{ version: string }, JenkinsPipelineServiceError>> {
    const connection = await this.connection(targetId, credentialId);
    return connection.ok ? this.jenkins.test(connection.value) : connection;
  }

  async save(
    input: SaveJenkinsPipelineInput,
  ): Promise<Result<JenkinsPipelineRecord, JenkinsPipelineServiceError>> {
    const valid = validatePipeline(input);
    if (!valid.ok) return valid;
    const target = await this.targets.get(valid.value.targetId);
    if (!target.ok) return target;
    const connection = await this.connection(valid.value.targetId, valid.value.jenkinsCredentialId);
    if (!connection.ok) return connection;
    const folder = `cloudforge-${slug(target.value.name)}-${target.value.id.slice(0, 8)}`;
    const existing = input.id
      ? await this.pipelines.get(input.id)
      : await this.pipelines.getByFolderAndName(folder, valid.value.name);
    if (!existing.ok) return existing;
    if (input.id && !existing.value)
      return err(new NotFoundError('The Jenkins pipeline no longer exists'));
    const id = existing.value?.id ?? input.id ?? newUuid();
    // After the existing record loads, because withdrawing HOST_PORT is only
    // safe when CloudForge's own history says it put it there.
    let jobParameters = synchronizeApplicationPortParameter(
      valid.value.parameters,
      valid.value.configureDomain,
      valid.value.applicationPort,
      existing.value?.configureDomain ?? false,
    );
    const folderResult = await this.jenkins.ensureFolder(connection.value, folder);
    if (!folderResult.ok) return folderResult;
    let githubCredentialId: string | null = null;
    if (valid.value.githubCredentialId) {
      const github = await this.credentials.getDecrypted(valid.value.githubCredentialId);
      if (!github.ok) return github;
      if (github.value.kind !== 'github')
        return err(new ValidationError('Select a GitHub credential'));
      const token = github.value.data.personalAccessToken?.trim();
      if (!token) return err(new ValidationError('The GitHub credential has no token'));
      githubCredentialId = `cloudforge-github-${id}`;
      const stored = await this.jenkins.ensureGithubCredential(
        connection.value,
        folder,
        githubCredentialId,
        token,
      );
      if (!stored.ok) return stored;
    }
    if (valid.value.environmentCredentialId) {
      const environmentCredential = await this.synchronizeEnvironmentCredential(
        id,
        folder,
        valid.value.environmentCredentialId,
        connection.value,
      );
      if (!environmentCredential.ok) return environmentCredential;
      jobParameters = synchronizeStringParameter(
        jobParameters,
        'CLOUDFORGE_ENV_CREDENTIAL_ID',
        environmentCredential.value,
        'Jenkins secret-text credential managed by CloudForge',
      );
    }
    const configured = await this.jenkins.upsertJob(connection.value, {
      folder,
      name: valid.value.name,
      description: valid.value.description,
      repositoryUrl: valid.value.repositoryUrl,
      branch: valid.value.branch,
      jenkinsfilePath: valid.value.jenkinsfilePath,
      pipelineScript: valid.value.pipelineScript,
      definitionMode: valid.value.definitionMode,
      parameters: jobParameters,
      environment: valid.value.environment,
      githubCredentialId,
    });
    if (!configured.ok) return configured;
    if (
      existing.value &&
      (existing.value.folder !== folder || existing.value.name !== valid.value.name)
    ) {
      const oldConnection = await this.connection(
        existing.value.targetId,
        existing.value.jenkinsCredentialId,
      );
      if (!oldConnection.ok) return oldConnection;
      const removedOldJob = await this.jenkins.removeJob(
        oldConnection.value,
        existing.value.folder,
        existing.value.name,
      );
      if (!removedOldJob.ok) return removedOldJob;
    }
    const now = toIsoDateString(new Date());
    const record: JenkinsPipelineRecord = {
      id,
      folder,
      ...valid.value,
      parameters: jobParameters,
      githubCredentialId: valid.value.githubCredentialId,
      cloudflareCredentialId: valid.value.cloudflareCredentialId,
      cloudflareZoneId: valid.value.cloudflareZoneId,
      lastStatus: 'configured',
      createdAt: existing.value?.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await this.pipelines.save(record);
    if (!saved.ok) return saved;
    if (record.configureDomain) {
      if (!this.managedDns || !this.nginx)
        return err(new DeploymentError('Domain automation is not available'));
      const dns = await this.managedDns.ensure(
        record.domain,
        target.value.host,
        record.cloudflareCredentialId ?? undefined,
        record.cloudflareZoneId ?? undefined,
      );
      if (!dns.ok) {
        const detail = dns.error instanceof Error ? `: ${dns.error.message}` : '';
        return err(
          new DeploymentError(`Could not configure Cloudflare DNS${detail}`, {
            cause: dns.error,
          }),
        );
      }
      if (dns.value.status !== 'propagated')
        return err(new DeploymentError('Cloudflare DNS was created but propagation is pending'));
      const sites = await this.nginx.listSites(record.targetId);
      if (!sites.ok)
        return err(
          new DeploymentError('Cloudflare DNS is ready but existing Nginx state could not load', {
            cause: sites.error,
          }),
        );
      const existingSite = sites.value.find(
        (site) => site.domain.toLowerCase() === record.domain.toLowerCase(),
      );
      const nginx = await this.nginx.saveSite(
        record.targetId,
        existingSite
          ? {
              ...existingSite,
              enabled: true,
              upstreamKind: 'host',
              upstreamHost: '127.0.0.1',
              upstreamPort: record.applicationPort ?? 80,
              websocket: true,
              locations: toNginxLocations(record.applicationRoutes),
              lastModified: now,
            }
          : {
              domain: record.domain,
              enabled: true,
              upstreamKind: 'host',
              upstreamHost: '127.0.0.1',
              upstreamPort: record.applicationPort ?? 80,
              websocket: true,
              ssl: false,
              httpRedirect: false,
              headers: [],
              extraDirectives: [],
              locations: toNginxLocations(record.applicationRoutes),
              proxyTimeoutSeconds: 60,
              clientMaxBodySize: '50m',
              compression: true,
              cache: false,
              customSnippets: [],
              lastModified: now,
            },
      );
      if (!nginx.ok)
        return err(
          new DeploymentError('Cloudflare DNS is ready but Nginx setup failed', {
            cause: nginx.error,
          }),
        );
      this.activities.recordSafe({
        type: 'jenkins.pipeline.domain.configured',
        message: `Configured ${record.domain} for Jenkins pipeline ${record.name}`,
        metadata: { pipelineId: record.id, targetId: record.targetId, domain: record.domain },
      });
    }
    this.activities.recordSafe({
      type: existing.value ? 'jenkins.pipeline.updated' : 'jenkins.pipeline.created',
      message: `${existing.value ? 'Updated' : 'Created'} Jenkins pipeline ${record.name}`,
      metadata: { pipelineId: record.id, targetId: record.targetId, folder: record.folder },
    });
    return ok(record);
  }

  async trigger(
    id: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<Result<void, JenkinsPipelineServiceError>> {
    const loaded = await this.load(id);
    if (!loaded.ok) return loaded;
    const connection = await this.connection(
      loaded.value.targetId,
      loaded.value.jenkinsCredentialId,
    );
    if (!connection.ok) return connection;
    if (loaded.value.environmentCredentialId) {
      const synchronizedEnvironment = await this.synchronizeEnvironmentCredential(
        loaded.value.id,
        loaded.value.folder,
        loaded.value.environmentCredentialId,
        connection.value,
      );
      if (!synchronizedEnvironment.ok) return synchronizedEnvironment;
    }
    const allowed = new Set(loaded.value.parameters.map((parameter) => parameter.name));
    if (Object.keys(parameters).some((name) => !allowed.has(name)))
      return err(new ValidationError('A build parameter is not declared by this pipeline'));
    const effectiveParameters = Object.fromEntries(
      loaded.value.parameters.map((parameter) => [parameter.name, parameter.defaultValue]),
    );
    Object.assign(effectiveParameters, parameters);
    // Last, so a caller cannot win. HOST_PORT is the one that bites: the Nginx
    // site this service wrote proxies to exactly that port, so a build run with
    // a different one deploys the container where the proxy is not looking and
    // the domain answers 502 with nothing in the log to explain it.
    Object.assign(effectiveParameters, managedBuildParameters(loaded.value));
    const result = await this.jenkins.trigger(
      connection.value,
      loaded.value.folder,
      loaded.value.name,
      effectiveParameters,
    );
    this.activities.recordSafe({
      type: result.ok ? 'jenkins.build.triggered' : 'jenkins.build.failed',
      message: `${result.ok ? 'Triggered' : 'Failed to trigger'} Jenkins pipeline ${loaded.value.name}`,
      metadata: { pipelineId: id, targetId: loaded.value.targetId },
    });
    return result;
  }

  async status(id: string): Promise<Result<JenkinsJobStatus, JenkinsPipelineServiceError>> {
    const loaded = await this.load(id);
    if (!loaded.ok) return loaded;
    const connection = await this.connection(
      loaded.value.targetId,
      loaded.value.jenkinsCredentialId,
    );
    if (!connection.ok) return connection;
    const status = await this.jenkins.status(
      connection.value,
      loaded.value.folder,
      loaded.value.name,
    );
    if (!status.ok) return status;
    const synchronizedParameters = synchronizeManagedParameters(
      status.value.parameters,
      loaded.value,
    );
    const synchronizedStatus = {
      ...status.value,
      parameters: synchronizedParameters,
    };
    if (synchronizedParameters.length > 0) {
      const saved = await this.pipelines.save({
        ...loaded.value,
        parameters: synchronizedParameters,
        lastStatus: status.value.lastBuildResult ?? status.value.color,
        updatedAt: toIsoDateString(new Date()),
      });
      if (!saved.ok) return saved;
    }
    return ok(synchronizedStatus);
  }

  async remove(id: string): Promise<Result<void, JenkinsPipelineServiceError>> {
    const loaded = await this.load(id);
    if (!loaded.ok) return loaded;
    const connection = await this.connection(
      loaded.value.targetId,
      loaded.value.jenkinsCredentialId,
    );
    if (!connection.ok) return connection;
    const removed = await this.jenkins.removeJob(
      connection.value,
      loaded.value.folder,
      loaded.value.name,
    );
    if (!removed.ok) return removed;
    const pruned = await this.jenkins.pruneEmptyFolder(connection.value, loaded.value.folder);
    if (!pruned.ok) return pruned;
    const deleted = await this.pipelines.remove(id);
    if (!deleted.ok) return deleted;
    this.activities.recordSafe({
      type: 'jenkins.pipeline.deleted',
      message: `Deleted Jenkins pipeline ${loaded.value.name}`,
      metadata: {
        pipelineId: id,
        targetId: loaded.value.targetId,
        folder: loaded.value.folder,
        folderDeleted: pruned.value,
      },
    });
    return ok(undefined);
  }

  private async load(
    id: string,
  ): Promise<Result<JenkinsPipelineRecord, JenkinsPipelineServiceError>> {
    const loaded = await this.pipelines.get(id);
    if (!loaded.ok) return loaded;
    return loaded.value ? ok(loaded.value) : err(new NotFoundError('Jenkins pipeline not found'));
  }

  private async connection(
    targetId: string,
    credentialId: string,
  ): Promise<Result<JenkinsConnection, JenkinsPipelineServiceError>> {
    const target = await this.targets.get(targetId);
    if (!target.ok) return target;
    const credential = await this.credentials.getDecrypted(credentialId);
    if (!credential.ok) return credential;
    if (credential.value.kind !== 'jenkins')
      return err(new ValidationError('Select a Jenkins credential'));
    const username = credential.value.data.username?.trim();
    const apiToken = credential.value.data.apiToken?.trim();
    if (!username || !apiToken)
      return err(new ValidationError('The Jenkins username and API token are required'));
    const configuredValue = credential.value.data.baseUrl?.trim();
    const configuredUrl = configuredValue?.length ? configuredValue : undefined;
    const baseUrl = (configuredUrl ?? `http://${target.value.host}:8080`).replace(/\/+$/, '');
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
      if (isLoopbackHost(parsed.hostname) && !isLoopbackHost(target.value.host)) {
        return err(
          new ValidationError(
            `The Jenkins URL ${baseUrl} points to this computer, not the selected VPS ${target.value.host}. Update the Jenkins secret to the VPS URL before creating or running pipelines.`,
          ),
        );
      }
    } catch {
      return err(new ValidationError('Enter a valid Jenkins HTTP or HTTPS URL'));
    }
    return ok({ baseUrl, username, apiToken });
  }

  private async synchronizeEnvironmentCredential(
    pipelineId: string,
    folder: string,
    credentialId: string,
    connection: JenkinsConnection,
  ): Promise<Result<string, JenkinsPipelineServiceError>> {
    const environmentCredential = await this.credentials.getDecrypted(credentialId);
    if (!environmentCredential.ok) return environmentCredential;
    if (environmentCredential.value.kind !== 'environment-file')
      return err(new ValidationError('Select a deployment environment file credential'));
    const content = environmentCredential.value.data.content;
    if (!content?.trim())
      return err(new ValidationError('The deployment environment file is empty'));
    const placeholders = environmentPlaceholderKeys(content);
    if (placeholders.length > 0) {
      return err(
        new ValidationError(
          `Complete the selected deployment environment before running Jenkins. Replace placeholder values for: ${placeholders.join(', ')}`,
        ),
      );
    }

    const remoteCredentialId = environmentJenkinsCredentialId(pipelineId);
    const stored = await this.jenkins.ensureSecretTextCredential(
      connection,
      folder,
      remoteCredentialId,
      Buffer.from(content, 'utf8').toString('base64'),
      `CloudForge ${environmentCredential.value.data.filename ?? '.env.production'}`,
    );
    if (!stored.ok) return stored;
    return ok(remoteCredentialId);
  }
}

/**
 * The parameters CloudForge sets rather than the person running the build.
 *
 * `HOST_PORT` is here because the Nginx site this service writes proxies to
 * exactly that port. A build run with a different one deploys the container
 * somewhere the reverse proxy is not looking, and the domain answers 502 — with
 * nothing in the pipeline log to explain why.
 */
const MANAGED_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'HOST_PORT',
  'CLOUDFORGE_ENV_CREDENTIAL_ID',
]);

export function isManagedJenkinsParameter(name: string): boolean {
  return MANAGED_PARAMETER_NAMES.has(name);
}

/**
 * Keep `HOST_PORT` equal to the port the domain is actually proxied to.
 *
 * The description is CloudForge's, not the caller's. Keeping whatever text
 * arrived would let a parameter this service owns describe itself as something
 * else.
 *
 * When domain automation is switched off, the parameter is removed — but only if
 * CloudForge put it there. `previouslyConfigured` is the evidence: this service
 * adds `HOST_PORT` only while `configureDomain` is on, so a pipeline that had it
 * on and now does not is one whose `HOST_PORT` is ours to withdraw. A pipeline
 * that never had it on may still have a `HOST_PORT` the user wrote by hand, and
 * that one is not ours to touch.
 */
function synchronizeApplicationPortParameter(
  parameters: readonly JenkinsParameter[],
  configureDomain: boolean,
  applicationPort: number | null,
  previouslyConfigured: boolean,
): readonly JenkinsParameter[] {
  if (!configureDomain || applicationPort === null)
    return previouslyConfigured
      ? parameters.filter((parameter) => parameter.name !== 'HOST_PORT')
      : parameters;
  return synchronizeStringParameter(
    parameters,
    'HOST_PORT',
    String(applicationPort),
    'Managed by CloudForge. Set the application port on the pipeline, not in Jenkins.',
  );
}

function validatePipeline(
  input: SaveJenkinsPipelineInput,
): Result<
  Omit<JenkinsPipelineRecord, 'id' | 'folder' | 'lastStatus' | 'createdAt' | 'updatedAt'>,
  ValidationError
> {
  const name = input.name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name))
    return err(
      new ValidationError(
        'Pipeline name must contain only letters, numbers, dot, dash or underscore',
      ),
    );
  if (!input.targetId || !input.jenkinsCredentialId)
    return err(new ValidationError('Select a VPS and Jenkins credential'));
  const repositoryUrl = input.repositoryUrl.trim();
  if (input.definitionMode === 'scm' && !/^(?:https?:\/\/|git@)[^\s]+$/.test(repositoryUrl))
    return err(new ValidationError('Enter a valid Git repository URL'));
  if (
    input.definitionMode === 'scm' &&
    input.repositoryAccess === 'private' &&
    !input.githubCredentialId
  )
    return err(new ValidationError('Private repositories require an encrypted GitHub credential'));
  const branch = input.branch.trim() || 'main';
  const jenkinsfilePath = input.jenkinsfilePath.trim() || 'Jenkinsfile';
  const pipelineScript = input.pipelineScript.trim();
  if (input.definitionMode === 'inline' && !pipelineScript)
    return err(new ValidationError('Enter an inline Jenkins pipeline script'));
  if (pipelineScript.length > 500_000)
    return err(new ValidationError('Pipeline script is too large'));
  const names = new Set<string>();
  for (const parameter of input.parameters) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(parameter.name) || names.has(parameter.name))
      return err(
        new ValidationError('Pipeline parameter names must be unique environment-style names'),
      );
    names.add(parameter.name);
    if (parameter.type === 'choice' && parameter.choices.length === 0)
      return err(new ValidationError(`Choice parameter ${parameter.name} needs choices`));
  }
  const environment = Object.fromEntries(
    Object.entries(input.environment)
      .map(([key, value]): [string, string] => [key.trim(), value.trim()])
      .filter(([key]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(key)),
  );
  if (
    Object.keys(environment).some((key) =>
      /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY|API_KEY)/.test(key),
    )
  )
    return err(
      new ValidationError(
        'Secret environment values must use Jenkins credentials or password build parameters',
      ),
    );
  const domain = input.domain.trim().toLowerCase();
  if (input.configureDomain && !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(domain))
    return err(new ValidationError('Enter a valid deployment domain'));
  const applicationPort = input.applicationPort ?? null;
  if (
    input.configureDomain &&
    (!applicationPort || applicationPort < 1 || applicationPort > 65_535)
  )
    return err(new ValidationError('Enter the application port exposed on the VPS'));
  const applicationRoutes = validateApplicationRoutes(input.applicationRoutes ?? []);
  if (!applicationRoutes.ok) return applicationRoutes;
  return ok({
    name,
    description: input.description.trim(),
    targetId: input.targetId,
    jenkinsCredentialId: input.jenkinsCredentialId,
    githubCredentialId: input.githubCredentialId ?? null,
    repositoryUrl,
    branch,
    jenkinsfilePath,
    pipelineScript,
    definitionMode: input.definitionMode,
    parameters: input.parameters.map((parameter) => {
      if (parameter.type === 'password') return { ...parameter, defaultValue: '' };
      if (parameter.type === 'boolean')
        return { ...parameter, defaultValue: parameter.defaultValue === 'true' ? 'true' : 'false' };
      if (parameter.type === 'choice')
        return {
          ...parameter,
          defaultValue: parameter.choices.includes(parameter.defaultValue)
            ? parameter.defaultValue
            : (parameter.choices[0] ?? ''),
        };
      return parameter;
    }),
    environment,
    environmentCredentialId: input.environmentCredentialId ?? null,
    domain,
    applicationPort,
    cloudflareCredentialId: input.cloudflareCredentialId ?? null,
    cloudflareZoneId: input.cloudflareZoneId ?? null,
    configureDomain: input.configureDomain,
    applicationRoutes: applicationRoutes.value,
  });
}

function validateApplicationRoutes(
  routes: readonly JenkinsApplicationRoute[],
): Result<readonly JenkinsApplicationRoute[], ValidationError> {
  const unique = new Map<string, JenkinsApplicationRoute>();
  for (const route of routes) {
    const path = route.path.trim();
    if (!/^\/[a-zA-Z0-9/_-]*$/.test(path))
      return err(new ValidationError(`Invalid application route: ${path}`));
    if (route.port < 1 || route.port > 65_535)
      return err(new ValidationError(`Invalid application route port: ${route.port}`));
    unique.set(path, { path, port: route.port });
  }
  return ok([...unique.values()]);
}

function toNginxLocations(routes: readonly JenkinsApplicationRoute[]): readonly NginxLocation[] {
  return routes.map((route) => ({
    path: route.path,
    upstreamHost: '127.0.0.1',
    upstreamPort: route.port,
    websocket: true,
    proxyTimeoutSeconds: 3_600,
  }));
}

function synchronizeStringParameter(
  parameters: readonly JenkinsParameter[],
  name: string,
  defaultValue: string,
  description: string,
): readonly JenkinsParameter[] {
  const next: JenkinsParameter = {
    name,
    type: 'string',
    defaultValue,
    description,
    choices: [],
    managed: true,
  };
  return parameters.some((parameter) => parameter.name === name)
    ? parameters.map((parameter) => (parameter.name === name ? next : parameter))
    : [...parameters, next];
}

/**
 * Restate what CloudForge owns over whatever Jenkins just reported.
 *
 * Jenkins is not the record of intent — the pipeline is. Someone with access to
 * the Jenkins UI can edit any parameter on a job, and reading those values back
 * as though they were the plan is how a hand-edit silently becomes the
 * configuration. This runs on every status read so the answer describes what the
 * pipeline means, and marks the drift as ours rather than hiding it.
 *
 * `HOST_PORT` is restated here as well as on save. It was not before, so a
 * pipeline whose port had been changed in Jenkins reported the changed value
 * indefinitely, while the Nginx site kept proxying to the original.
 */
function synchronizeManagedParameters(
  parameters: readonly JenkinsParameter[],
  pipeline: JenkinsPipelineRecord,
): readonly JenkinsParameter[] {
  let next = synchronizeApplicationPortParameter(
    parameters,
    pipeline.configureDomain,
    pipeline.applicationPort ?? null,
    // A stored pipeline is the record of intent, so its own `configureDomain`
    // is the authority on whether a HOST_PORT here would be CloudForge's.
    pipeline.configureDomain,
  );
  if (pipeline.environmentCredentialId) {
    next = synchronizeStringParameter(
      next,
      'CLOUDFORGE_ENV_CREDENTIAL_ID',
      environmentJenkinsCredentialId(pipeline.id),
      'Managed by CloudForge. Select the encrypted deployment environment in CloudForge, not Jenkins.',
    );
  }
  return next;
}

/**
 * The values CloudForge insists on for a build, whatever the caller sent.
 *
 * Not a validation step — a correction. Rejecting instead would turn a caller
 * that sends back the value it was shown into an error, and the run form does
 * exactly that. What must never happen is the *other* case: a caller sending a
 * different value and having it honoured.
 */
function managedBuildParameters(pipeline: JenkinsPipelineRecord): Record<string, string> {
  const managed: Record<string, string> = {};
  for (const parameter of synchronizeManagedParameters(pipeline.parameters, pipeline)) {
    if (parameter.managed === true) managed[parameter.name] = parameter.defaultValue;
  }
  return managed;
}

function environmentJenkinsCredentialId(pipelineId: string): string {
  return `cloudforge-env-${pipelineId}`;
}

function environmentPlaceholderKeys(content: string): readonly string[] {
  const environment = parseEnvironmentAssignments(content);
  const optionalPlaceholders = new Set(
    (environment.CLOUDFORGE_OPTIONAL_PLACEHOLDERS ?? '')
      .replace(/^['"]|['"]$/g, '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    if (value.includes('CHANGE_ME_') && !optionalPlaceholders.has(key)) keys.add(key);
  }
  return [...keys];
}

function parseEnvironmentAssignments(content: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (assignment?.[1]) environment[assignment[1]] = assignment[2] ?? '';
  }
  return environment;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'vps'
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  );
}
