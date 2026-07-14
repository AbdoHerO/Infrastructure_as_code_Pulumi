import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

export type AnsibleProfileId = 'docker' | 'dockhand' | 'portainer' | 'jenkins' | 'nginx';
export type AnsibleVariableType = 'string' | 'number' | 'boolean';

export interface AnsibleVariableSpec {
  readonly key: string;
  readonly label: string;
  readonly type: AnsibleVariableType;
  readonly required: boolean;
  readonly secret?: boolean;
  readonly defaultValue?: string | number | boolean;
  readonly description?: string;
}

export interface AnsibleProfile {
  readonly id: AnsibleProfileId;
  readonly name: string;
  readonly description: string;
  readonly variables: readonly AnsibleVariableSpec[];
}

export interface AnsibleStatus {
  readonly installed: boolean;
  readonly version: string | null;
}

export interface AnsibleEvent {
  readonly stream: 'stdout' | 'stderr' | 'step' | 'error';
  readonly message: string;
}

export type AnsibleEventSink = (event: AnsibleEvent) => void;

export interface AnsibleOutcome {
  readonly success: boolean;
  readonly summary: string;
}

export interface NginxSite {
  readonly domain: string;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly websocket: boolean;
}

export interface AnsibleRunOptions {
  readonly signal?: AbortSignal;
}

export interface AnsibleManager {
  profiles(): readonly AnsibleProfile[];
  inspectHostKey(host: string, port: number): Promise<Result<string, DeploymentError>>;
  status(target: DeploymentTarget): Promise<Result<AnsibleStatus, DeploymentError>>;
  bootstrap(
    target: DeploymentTarget,
    onEvent?: AnsibleEventSink,
    options?: AnsibleRunOptions,
  ): Promise<Result<AnsibleStatus, DeploymentError>>;
  run(
    target: DeploymentTarget,
    profileId: AnsibleProfileId,
    variables: Readonly<Record<string, unknown>>,
    onEvent?: AnsibleEventSink,
    options?: AnsibleRunOptions,
  ): Promise<Result<AnsibleOutcome, DeploymentError>>;
  listNginxSites(target: DeploymentTarget): Promise<Result<NginxSite[], DeploymentError>>;
  upsertNginxSite(
    target: DeploymentTarget,
    site: NginxSite,
    onEvent?: AnsibleEventSink,
    options?: AnsibleRunOptions,
  ): Promise<Result<AnsibleOutcome, DeploymentError>>;
  removeNginxSite(
    target: DeploymentTarget,
    domain: string,
    onEvent?: AnsibleEventSink,
    options?: AnsibleRunOptions,
  ): Promise<Result<AnsibleOutcome, DeploymentError>>;
}
