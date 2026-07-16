import type {
  JenkinsConnection,
  JenkinsJobDefinition,
  JenkinsJobStatus,
  JenkinsManager,
  JenkinsParameter,
} from '@cloudforge/core';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';

export class JenkinsHttpManager implements JenkinsManager {
  async test(connection: JenkinsConnection): Promise<Result<{ version: string }, DeploymentError>> {
    const response = await request(connection, '/api/json?tree=nodeName');
    return response.ok
      ? ok({ version: response.value.headers.get('x-jenkins') ?? 'unknown' })
      : response;
  }

  async ensureFolder(
    connection: JenkinsConnection,
    folder: string,
  ): Promise<Result<void, DeploymentError>> {
    const existing = await request(connection, `/job/${segment(folder)}/api/json`, {
      acceptNotFound: true,
    });
    if (!existing.ok) return existing;
    if (existing.value.status !== 404) return ok(undefined);
    // Let the Folder plugin construct the object. Creating a folder from a
    // hand-written config.xml leaves the initial AllView without an owner on
    // some current Jenkins/plugin combinations, which breaks the folder UI
    // until Jenkins is restarted.
    const created = await request(
      connection,
      `/createItem?name=${encodeURIComponent(folder)}&mode=${encodeURIComponent('com.cloudbees.hudson.plugins.folder.Folder')}`,
      {
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({ json: '{}' }).toString(),
      },
    );
    return created.ok ? ok(undefined) : created;
  }

  async ensureGithubCredential(
    connection: JenkinsConnection,
    folder: string,
    credentialId: string,
    token: string,
  ): Promise<Result<void, DeploymentError>> {
    const path = `/job/${segment(folder)}/credentials/store/folder/domain/_/credential/${segment(credentialId)}/config.xml`;
    const updated = await request(connection, path, {
      method: 'POST',
      contentType: 'application/xml',
      body: githubCredentialXml(credentialId, token),
      acceptNotFound: true,
    });
    if (!updated.ok) return updated;
    if (updated.value.status !== 404) return ok(undefined);
    const payload = JSON.stringify({
      '': '0',
      credentials: {
        scope: 'GLOBAL',
        id: credentialId,
        username: 'x-access-token',
        password: token,
        description: 'Managed by CloudForge',
        $class: 'com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl',
      },
    });
    const created = await request(
      connection,
      `/job/${segment(folder)}/credentials/store/folder/domain/_/createCredentials`,
      {
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({ json: payload }).toString(),
      },
    );
    return created.ok ? ok(undefined) : created;
  }

  async ensureSecretTextCredential(
    connection: JenkinsConnection,
    folder: string,
    credentialId: string,
    secret: string,
    description: string,
  ): Promise<Result<void, DeploymentError>> {
    const path = `/job/${segment(folder)}/credentials/store/folder/domain/_/credential/${segment(credentialId)}/config.xml`;
    const updated = await request(connection, path, {
      method: 'POST',
      contentType: 'application/xml',
      body: secretTextCredentialXml(credentialId, secret, description),
      acceptNotFound: true,
    });
    if (!updated.ok) return updated;
    if (updated.value.status !== 404) return ok(undefined);
    const payload = JSON.stringify({
      '': '0',
      credentials: {
        scope: 'GLOBAL',
        id: credentialId,
        secret,
        description,
        $class: 'org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl',
      },
    });
    const created = await request(
      connection,
      `/job/${segment(folder)}/credentials/store/folder/domain/_/createCredentials`,
      {
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({ json: payload }).toString(),
      },
    );
    return created.ok ? ok(undefined) : created;
  }

  async upsertJob(
    connection: JenkinsConnection,
    definition: JenkinsJobDefinition,
  ): Promise<Result<void, DeploymentError>> {
    const jobPath = `/job/${segment(definition.folder)}/job/${segment(definition.name)}`;
    const existing = await request(connection, `${jobPath}/api/json`, { acceptNotFound: true });
    if (!existing.ok) return existing;
    const config = jobXml(definition);
    const saved =
      existing.value.status === 404
        ? await request(
            connection,
            `/job/${segment(definition.folder)}/createItem?name=${encodeURIComponent(definition.name)}`,
            { method: 'POST', contentType: 'application/xml', body: config },
          )
        : await request(connection, `${jobPath}/config.xml`, {
            method: 'POST',
            contentType: 'application/xml',
            body: config,
          });
    return saved.ok ? ok(undefined) : saved;
  }

  async removeJob(
    connection: JenkinsConnection,
    folder: string,
    name: string,
  ): Promise<Result<void, DeploymentError>> {
    const removed = await request(
      connection,
      `/job/${segment(folder)}/job/${segment(name)}/doDelete`,
      { method: 'POST', acceptNotFound: true },
    );
    return removed.ok ? ok(undefined) : removed;
  }

  async pruneEmptyFolder(
    connection: JenkinsConnection,
    folder: string,
  ): Promise<Result<boolean, DeploymentError>> {
    const folderPath = `/job/${segment(folder)}`;
    const response = await request(connection, `${folderPath}/api/json?tree=jobs[name]`, {
      acceptNotFound: true,
    });
    if (!response.ok) return response;
    if (response.value.status === 404) return ok(false);
    try {
      const data = (await response.value.json()) as { jobs?: readonly { name?: string }[] };
      if ((data.jobs?.length ?? 0) > 0) return ok(false);
      const removed = await request(connection, `${folderPath}/doDelete`, {
        method: 'POST',
        acceptNotFound: true,
      });
      return removed.ok ? ok(removed.value.status !== 404) : removed;
    } catch (cause) {
      return err(new DeploymentError('Jenkins returned an invalid folder status', { cause }));
    }
  }

  async trigger(
    connection: JenkinsConnection,
    folder: string,
    name: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<Result<void, DeploymentError>> {
    const suffix = Object.keys(parameters).length > 0 ? 'buildWithParameters' : 'build';
    const body = new URLSearchParams(parameters).toString();
    const triggered = await request(
      connection,
      `/job/${segment(folder)}/job/${segment(name)}/${suffix}`,
      {
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body,
      },
    );
    return triggered.ok ? ok(undefined) : triggered;
  }

  async status(
    connection: JenkinsConnection,
    folder: string,
    name: string,
  ): Promise<Result<JenkinsJobStatus, DeploymentError>> {
    const jobPath = `/job/${segment(folder)}/job/${segment(name)}`;
    // Jenkins 2.568 can fail with HTTP 500 when the tree API asks for nested
    // lastBuild fields on a Pipeline that has never run. Load the shallow job
    // representation first; it safely returns lastBuild: null for a new job.
    const response = await request(connection, `${jobPath}/api/json`, { acceptNotFound: true });
    if (!response.ok) return response;
    if (response.value.status === 404)
      return ok({
        exists: false,
        enabled: false,
        color: 'not-built',
        inQueue: false,
        lastBuildNumber: null,
        lastBuildResult: null,
        lastBuildUrl: null,
        parameters: [],
      });
    try {
      const data = (await response.value.json()) as {
        buildable?: boolean;
        color?: string;
        inQueue?: boolean;
        lastBuild?: { number?: number; result?: string | null; url?: string } | null;
        property?: readonly JenkinsParameterProperty[];
      };
      let lastBuildResult = data.lastBuild?.result ?? null;
      let lastBuildUrl = data.lastBuild?.url ?? null;
      const lastBuildNumber = data.lastBuild?.number ?? null;
      if (lastBuildNumber !== null && (lastBuildResult === null || lastBuildUrl === null)) {
        const buildResponse = await request(
          connection,
          `${jobPath}/${lastBuildNumber}/api/json?tree=number,result,url`,
          { acceptNotFound: true },
        );
        if (!buildResponse.ok) return buildResponse;
        if (buildResponse.value.status !== 404) {
          const build = (await buildResponse.value.json()) as {
            result?: string | null;
            url?: string;
          };
          lastBuildResult = build.result ?? null;
          lastBuildUrl = build.url ?? lastBuildUrl;
        }
      }
      return ok({
        exists: true,
        enabled: data.buildable ?? false,
        color: data.color ?? 'unknown',
        inQueue: data.inQueue ?? false,
        lastBuildNumber,
        lastBuildResult,
        lastBuildUrl,
        parameters: parseParameters(data.property),
      });
    } catch (cause) {
      return err(new DeploymentError('Jenkins returned an invalid job status', { cause }));
    }
  }
}

interface JenkinsParameterProperty {
  readonly parameterDefinitions?: readonly {
    readonly name?: string;
    readonly description?: string;
    readonly type?: string;
    readonly _class?: string;
    readonly choices?: readonly string[];
    readonly defaultParameterValue?: { readonly value?: unknown } | null;
  }[];
}

function parseParameters(
  properties: readonly JenkinsParameterProperty[] | undefined,
): JenkinsParameter[] {
  return (properties ?? [])
    .flatMap((property) => property.parameterDefinitions ?? [])
    .flatMap((definition) => {
      const name = definition.name?.trim();
      if (!name) return [];
      const discriminator = `${definition.type ?? ''} ${definition._class ?? ''}`.toLowerCase();
      const choices = (definition.choices ?? []).map(String);
      const type: JenkinsParameter['type'] = discriminator.includes('choice')
        ? 'choice'
        : discriminator.includes('boolean')
          ? 'boolean'
          : discriminator.includes('password')
            ? 'password'
            : 'string';
      const rawDefault = definition.defaultParameterValue?.value;
      return [
        {
          name,
          type,
          defaultValue: type === 'password' ? '' : scalarString(rawDefault),
          description: definition.description ?? '',
          choices,
        },
      ];
    });
}

function scalarString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly contentType?: string;
  readonly body?: string;
  readonly acceptNotFound?: boolean;
}

async function request(
  connection: JenkinsConnection,
  path: string,
  options: RequestOptions = {},
): Promise<Result<Response, DeploymentError>> {
  try {
    const headers = new Headers({
      Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.apiToken}`).toString('base64')}`,
      Accept: 'application/json',
    });
    if (options.contentType) headers.set('Content-Type', contentType(options.contentType));
    if (options.method === 'POST') {
      const crumb = await fetch(`${connection.baseUrl}/crumbIssuer/api/json`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (crumb.ok) {
        const data = (await crumb.json()) as { crumbRequestField?: string; crumb?: string };
        if (data.crumbRequestField && data.crumb) headers.set(data.crumbRequestField, data.crumb);
      }
    }
    const response = await fetch(`${connection.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (
      response.ok ||
      (options.method === 'POST' && response.status >= 300 && response.status < 400) ||
      (options.acceptNotFound && response.status === 404)
    )
      return ok(response);
    const details = (await response.text())
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return err(
      new DeploymentError(
        `Jenkins request failed (${response.status})${details ? `: ${details.slice(0, 300)}` : ''}`,
      ),
    );
  } catch (cause) {
    return err(new DeploymentError('Could not connect to Jenkins', { cause }));
  }
}

function githubCredentialXml(id: string, token: string): string {
  return `<com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>
<scope>GLOBAL</scope><id>${xml(id)}</id><description>Managed by CloudForge</description>
<username>x-access-token</username><password>${xml(token)}</password>
</com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl>`;
}

function secretTextCredentialXml(id: string, secret: string, description: string): string {
  return `<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>
<scope>GLOBAL</scope><id>${xml(id)}</id><description>${xml(description)}</description>
<secret>${xml(secret)}</secret>
</org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>`;
}

function jobXml(definition: JenkinsJobDefinition): string {
  const properties = definition.parameters.length
    ? `<hudson.model.ParametersDefinitionProperty><parameterDefinitions>${definition.parameters.map(parameterXml).join('')}</parameterDefinitions></hudson.model.ParametersDefinitionProperty>`
    : '';
  const environment = Object.entries(definition.environment)
    .map(([key, value]) => `${key} = '${groovy(value)}'`)
    .join('\n');
  const inline = environment
    ? `pipeline { agent any; environment { ${environment} }; stages { stage('CloudForge pipeline') { steps { script { ${definition.pipelineScript} } } } } }`
    : definition.pipelineScript;
  const pipelineDefinition =
    definition.definitionMode === 'inline'
      ? `<definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps"><script>${xml(inline)}</script><sandbox>true</sandbox></definition>`
      : `<definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
<scm class="hudson.plugins.git.GitSCM" plugin="git"><configVersion>2</configVersion>
<userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>${xml(definition.repositoryUrl)}</url>${definition.githubCredentialId ? `<credentialsId>${xml(definition.githubCredentialId)}</credentialsId>` : ''}</hudson.plugins.git.UserRemoteConfig></userRemoteConfigs>
<branches><hudson.plugins.git.BranchSpec><name>${xml(branchSpec(definition.branch))}</name></hudson.plugins.git.BranchSpec></branches>
<doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations><submoduleCfg class="empty-list"/><extensions/>
</scm><scriptPath>${xml(definition.jenkinsfilePath)}</scriptPath><lightweight>true</lightweight></definition>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<flow-definition plugin="workflow-job"><actions/><description>${xml(definition.description)}</description>
<keepDependencies>false</keepDependencies><properties>${properties}</properties>${pipelineDefinition}
<triggers/><disabled>false</disabled></flow-definition>`;
}

function parameterXml(parameter: JenkinsParameter): string {
  const description = `<description>${xml(parameter.description)}</description>`;
  if (parameter.type === 'boolean')
    return `<hudson.model.BooleanParameterDefinition><name>${xml(parameter.name)}</name>${description}<defaultValue>${parameter.defaultValue === 'true'}</defaultValue></hudson.model.BooleanParameterDefinition>`;
  if (parameter.type === 'choice')
    return `<hudson.model.ChoiceParameterDefinition><name>${xml(parameter.name)}</name>${description}<choices class="java.util.Arrays$ArrayList"><a class="string-array">${parameter.choices.map((choice) => `<string>${xml(choice)}</string>`).join('')}</a></choices></hudson.model.ChoiceParameterDefinition>`;
  if (parameter.type === 'password')
    return `<hudson.model.PasswordParameterDefinition><name>${xml(parameter.name)}</name>${description}<defaultValue>${xml(parameter.defaultValue)}</defaultValue></hudson.model.PasswordParameterDefinition>`;
  return `<hudson.model.StringParameterDefinition><name>${xml(parameter.name)}</name>${description}<defaultValue>${xml(parameter.defaultValue)}</defaultValue><trim>true</trim></hudson.model.StringParameterDefinition>`;
}

function branchSpec(branch: string): string {
  return branch.startsWith('refs/') || branch.includes('*') ? branch : `*/${branch}`;
}
function segment(value: string): string {
  return encodeURIComponent(value);
}
function contentType(value: string): string {
  return value === 'application/xml' ? 'application/xml; charset=UTF-8' : value;
}
function xml(value: string): string {
  return sanitizeXmlText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function sanitizeXmlText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) return false;
      if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
      if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
      if (codePoint >= 0xa0 && codePoint <= 0xd7ff) return true;
      if (codePoint >= 0xe000 && codePoint <= 0xfffd) return true;
      return codePoint >= 0x10000 && codePoint <= 0x10ffff;
    })
    .join('');
}
function groovy(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
