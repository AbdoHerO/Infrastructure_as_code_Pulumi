import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentStep } from '../deployment/deployment-template.js';

/** SSH connection details for a deployment target host. */
export interface DeploymentTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey: string;
  readonly passphrase?: string | undefined;
  /** Trusted SHA-256 host-key fingerprint (base64, with or without SHA256: prefix). */
  readonly hostKeySha256: string;
}

export interface DeploymentOptions {
  readonly signal?: AbortSignal;
  readonly stepTimeoutMs?: number;
}

/** A streamed event emitted during a deployment. */
export interface DeployEvent {
  readonly stream: 'stdout' | 'stderr' | 'step' | 'error';
  readonly message: string;
}

export type DeployEventSink = (event: DeployEvent) => void;

/** Result of running a deployment's steps. */
export interface DeploymentOutcome {
  readonly success: boolean;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

/**
 * Port that executes an ordered set of deployment steps on a target host. The
 * concrete implementation (SSH) lives in `@cloudforge/deployment`; an Ansible
 * playbook runner can be added behind the same port.
 */
export interface Deployer {
  /** Read the server's presented host key without authenticating or trusting it. */
  inspectHostKey(host: string, port: number): Promise<Result<string, DeploymentError>>;

  deploy(
    target: DeploymentTarget,
    steps: readonly DeploymentStep[],
    onEvent?: DeployEventSink,
    options?: DeploymentOptions,
  ): Promise<Result<DeploymentOutcome, DeploymentError>>;
}
