import type { DeploymentError, Result } from '@cloudforge/shared';

export interface JenkinsConnection {
  readonly baseUrl: string;
  readonly username: string;
  readonly apiToken: string;
}

export type JenkinsParameterType = 'string' | 'boolean' | 'choice' | 'password';

export interface JenkinsParameter {
  readonly name: string;
  readonly type: JenkinsParameterType;
  readonly defaultValue: string;
  readonly description: string;
  readonly choices: readonly string[];
}

export interface JenkinsJobDefinition {
  readonly folder: string;
  readonly name: string;
  readonly description: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly jenkinsfilePath: string;
  readonly pipelineScript: string;
  readonly definitionMode: 'scm' | 'inline';
  readonly parameters: readonly JenkinsParameter[];
  readonly environment: Readonly<Record<string, string>>;
  readonly githubCredentialId: string | null;
}

export interface JenkinsJobStatus {
  readonly exists: boolean;
  readonly enabled: boolean;
  readonly color: string;
  readonly inQueue: boolean;
  readonly lastBuildNumber: number | null;
  readonly lastBuildResult: string | null;
  readonly lastBuildUrl: string | null;
}

export interface JenkinsManager {
  test(connection: JenkinsConnection): Promise<Result<{ version: string }, DeploymentError>>;
  ensureFolder(
    connection: JenkinsConnection,
    folder: string,
  ): Promise<Result<void, DeploymentError>>;
  ensureGithubCredential(
    connection: JenkinsConnection,
    folder: string,
    credentialId: string,
    token: string,
  ): Promise<Result<void, DeploymentError>>;
  upsertJob(
    connection: JenkinsConnection,
    definition: JenkinsJobDefinition,
  ): Promise<Result<void, DeploymentError>>;
  removeJob(
    connection: JenkinsConnection,
    folder: string,
    name: string,
  ): Promise<Result<void, DeploymentError>>;
  trigger(
    connection: JenkinsConnection,
    folder: string,
    name: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<Result<void, DeploymentError>>;
  status(
    connection: JenkinsConnection,
    folder: string,
    name: string,
  ): Promise<Result<JenkinsJobStatus, DeploymentError>>;
}
