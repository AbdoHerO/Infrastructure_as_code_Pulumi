import type { DeploymentError, Result } from '@cloudforge/shared';
import type { ExposureMode, RuntimeOwnership } from '../vps-runtime/runtime-ownership.js';
import type { DeploymentTarget } from './deployer.js';

/**
 * What a VPS's Docker runtime actually looks like right now.
 *
 * Strictly a reading. Nothing here is desired state, and inspecting never
 * changes the VPS — an inventory has to be safe to run against a production
 * server before anything else in the runtime layer can be trusted.
 */

/** One container port, with the distinction `docker ps` collapses. */
export interface ObservedPort {
  readonly containerPort: number;
  readonly protocol: 'tcp' | 'udp';
  /** The host port it is published on, or null when only exposed inside Docker. */
  readonly hostPort: number | null;
  /** The host interface it is published on, or null when not published. */
  readonly bindAddress: string | null;
  readonly exposure: Exclude<ExposureMode, 'proxy-only'>;
}

/** A container's membership of one Docker network, and the names it answers to there. */
export interface ObservedNetworkAttachment {
  readonly network: string;
  readonly aliases: readonly string[];
  readonly ipAddress: string | null;
}

export interface ObservedMount {
  readonly source: string;
  readonly destination: string;
  readonly kind: string;
  readonly readOnly: boolean;
}

export interface ObservedContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly health: string | null;
  readonly createdAt: string | null;
  readonly restartPolicy: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly ownership: RuntimeOwnership;
  readonly composeProject: string | null;
  readonly composeService: string | null;
  readonly ports: readonly ObservedPort[];
  readonly networks: readonly ObservedNetworkAttachment[];
  readonly mounts: readonly ObservedMount[];
}

export interface ObservedNetwork {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  /** An internal network has no route out; containers on it cannot reach the internet. */
  readonly internal: boolean;
  readonly attachable: boolean;
  readonly ipv6: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly ownership: RuntimeOwnership;
  readonly containerNames: readonly string[];
}

export interface ObservedVolume {
  readonly name: string;
  readonly driver: string;
  readonly mountPoint: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly ownership: RuntimeOwnership;
  /** Containers currently mounting it. A volume in use must never be removed. */
  readonly containerNames: readonly string[];
}

export interface ObservedDockerEngine {
  readonly available: boolean;
  readonly version: string | null;
  readonly composeVersion: string | null;
}

export interface RuntimeObservation {
  readonly targetId: string;
  readonly observedAt: string;
  readonly docker: ObservedDockerEngine;
  readonly containers: readonly ObservedContainer[];
  readonly networks: readonly ObservedNetwork[];
  readonly volumes: readonly ObservedVolume[];
}

/** Reads a VPS's live runtime. Implementations must not mutate the target. */
export interface RuntimeInspector {
  inspect(
    target: DeploymentTarget,
    targetId: string,
  ): Promise<Result<RuntimeObservation, DeploymentError>>;
}
