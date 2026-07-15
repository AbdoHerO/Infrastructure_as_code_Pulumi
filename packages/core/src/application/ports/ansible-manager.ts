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

export type AnsibleProfileRuntimeStatus = 'not-installed' | 'stopped' | 'running' | 'unhealthy';

/** Live, target-specific state discovered from the VPS rather than run history. */
export interface AnsibleProfileState {
  readonly profileId: AnsibleProfileId;
  readonly status: AnsibleProfileRuntimeStatus;
  readonly installed: boolean;
  readonly running: boolean;
  readonly version: string | null;
  readonly port: number | null;
  /** Native host firewall only. Cloud-provider ingress is managed separately. */
  readonly hostFirewallOpen: boolean | null;
  readonly detail: string;
  readonly checkedAt: string;
}

export type VpsCheckStatus = 'ready' | 'warning' | 'repairable' | 'blocked';

export interface VpsPreflightCheck {
  readonly id: string;
  readonly category: 'connection' | 'system' | 'runtime' | 'network' | 'resources' | 'profile';
  readonly label: string;
  readonly status: VpsCheckStatus;
  readonly message: string;
}

export interface VpsFacts {
  readonly hostname: string;
  readonly osId: string;
  readonly osName: string;
  readonly osVersion: string;
  readonly architecture: string;
  readonly kernel: string;
  readonly packageManager: string;
  readonly initSystem: string;
  readonly pythonVersion: string | null;
  readonly ansibleVersion: string | null;
  readonly memoryMb: number;
  readonly diskFreeMb: number;
  readonly firewall: string;
  readonly selinux: string;
}

export interface VpsPreflightReport {
  readonly status: 'ready' | 'needs-repair' | 'blocked';
  readonly checkedAt: string;
  readonly profileId: AnsibleProfileId | null;
  readonly facts: VpsFacts;
  readonly checks: readonly VpsPreflightCheck[];
  readonly repairPackages: readonly string[];
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

/** Sensitive, short-lived access information read from a managed service. */
export interface AnsibleAccessDetails {
  readonly profileId: AnsibleProfileId;
  readonly url: string;
  readonly secretLabel: string;
  readonly secret: string | null;
  readonly instructions: string;
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
  profileStates(
    target: DeploymentTarget,
  ): Promise<Result<readonly AnsibleProfileState[], DeploymentError>>;
  preflight(
    target: DeploymentTarget,
    profileId?: AnsibleProfileId,
    variables?: Readonly<Record<string, unknown>>,
  ): Promise<Result<VpsPreflightReport, DeploymentError>>;
  repair(
    target: DeploymentTarget,
    onEvent?: AnsibleEventSink,
    options?: AnsibleRunOptions,
  ): Promise<Result<VpsPreflightReport, DeploymentError>>;
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
  access(
    target: DeploymentTarget,
    profileId: AnsibleProfileId,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Result<AnsibleAccessDetails | null, DeploymentError>>;
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
