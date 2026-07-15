import type { PersistenceError, Result } from '@cloudforge/shared';
import type { JenkinsParameter } from './jenkins-manager.js';

export interface JenkinsPipelineRecord {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly description: string;
  readonly targetId: string;
  readonly jenkinsCredentialId: string;
  readonly githubCredentialId: string | null;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly jenkinsfilePath: string;
  readonly pipelineScript: string;
  readonly definitionMode: 'scm' | 'inline';
  readonly parameters: readonly JenkinsParameter[];
  readonly environment: Readonly<Record<string, string>>;
  readonly domain: string;
  readonly applicationPort: number | null;
  readonly cloudflareCredentialId: string | null;
  readonly cloudflareZoneId: string | null;
  readonly configureDomain: boolean;
  readonly lastStatus: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JenkinsPipelineRepository {
  list(): Promise<Result<JenkinsPipelineRecord[], PersistenceError>>;
  get(id: string): Promise<Result<JenkinsPipelineRecord | null, PersistenceError>>;
  save(record: JenkinsPipelineRecord): Promise<Result<void, PersistenceError>>;
  remove(id: string): Promise<Result<void, PersistenceError>>;
}
