import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

export interface RemoteContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: string;
}

export interface ContainerStats {
  readonly name: string;
  readonly cpu: string;
  readonly memory: string;
  readonly networkIo: string;
  readonly blockIo: string;
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove';

export interface ContainerManager {
  list(target: DeploymentTarget): Promise<Result<RemoteContainer[], DeploymentError>>;
  action(
    target: DeploymentTarget,
    containerId: string,
    action: ContainerAction,
  ): Promise<Result<void, DeploymentError>>;
  logs(
    target: DeploymentTarget,
    containerId: string,
    lines: number,
  ): Promise<Result<string, DeploymentError>>;
  stats(
    target: DeploymentTarget,
    containerId: string,
  ): Promise<Result<ContainerStats, DeploymentError>>;
  deployCompose(
    target: DeploymentTarget,
    projectName: string,
    composeYaml: string,
  ): Promise<Result<void, DeploymentError>>;
}
