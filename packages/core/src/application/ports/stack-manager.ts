import type { DeploymentError, PersistenceError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

/** One service found in a Compose file. */
export interface ComposeServiceInfo {
  readonly name: string;
  readonly image: string | null;
  readonly containerName: string | null;
  /** Ports the file declares (`ports` and `expose`), offered when choosing a route. */
  readonly ports: readonly number[];
  /** `network_mode: host` shares the server's network, so no port can be mapped for it. */
  readonly hostNetwork: boolean;
}

/** What CloudForge understood from a Compose file and its `.env`, without its values. */
export interface ComposeAnalysis {
  /** The file's top-level `name`, offered as the stack name. */
  readonly name: string | null;
  readonly services: readonly ComposeServiceInfo[];
  /** Declared `external: true`; they must exist on the server, so CloudForge creates them. */
  readonly externalNetworks: readonly string[];
  readonly externalVolumes: readonly string[];
  /** The stack cannot be deployed until these are fixed. */
  readonly errors: readonly string[];
  /** Deployable, but the user should know. */
  readonly warnings: readonly string[];
}

/** Reads Compose YAML. An adapter, because the YAML parser stays out of the core. */
export interface ComposeAnalyzer {
  analyze(composeYaml: string, environment: string): ComposeAnalysis;
}

/** Everything the server needs to bring one stack up. */
export interface StackDeployment {
  /** Compose project: also the directory name on the server. */
  readonly project: string;
  /** The user's file, uploaded as is. May hold secrets, so never placed in a script. */
  readonly composeYaml: string;
  /** The user's `.env`. Secrets: uploaded owner-only and never placed in a script. */
  readonly environment: string;
  /** Generated file adding the loopback ports and labels. Holds no secret. */
  readonly overrideYaml: string;
  readonly externalNetworks: readonly string[];
  readonly externalVolumes: readonly string[];
  /** Fixed container names, checked against containers of other stacks first. */
  readonly containerNames: readonly string[];
  /** Local ports the stack will publish, refused when something else listens on them. */
  readonly hostPorts: readonly number[];
}

export interface StackContainerState {
  readonly service: string;
  readonly name: string;
  readonly state: string;
  readonly health: string;
  readonly image: string;
}

export interface StackPortState {
  readonly port: number;
  /** `closed` means the container did not answer in time; `unknown` means no way to test. */
  readonly state: 'open' | 'closed' | 'unknown';
}

export interface StackRuntimeStatus {
  readonly project: string;
  readonly containers: readonly StackContainerState[];
  readonly ports: readonly StackPortState[];
}

export interface StackEvent {
  readonly stream: 'step' | 'stdout' | 'stderr' | 'error';
  readonly message: string;
}
export type StackEventSink = (event: StackEvent) => void;

/** Remote side of a stack: one Docker Compose project. */
export interface StackManager {
  deploy(
    target: DeploymentTarget,
    deployment: StackDeployment,
    onEvent?: StackEventSink,
  ): Promise<Result<StackRuntimeStatus, DeploymentError>>;
  status(
    target: DeploymentTarget,
    project: string,
    hostPorts: readonly number[],
  ): Promise<Result<StackRuntimeStatus, DeploymentError>>;
  /** Stop and remove the containers; with `deleteData` also its own volumes and files. */
  remove(
    target: DeploymentTarget,
    project: string,
    deleteData: boolean,
    onEvent?: StackEventSink,
  ): Promise<Result<void, DeploymentError>>;
  /** Ports already taken on the server, to choose a free one for a new route. */
  usedPorts(target: DeploymentTarget): Promise<Result<readonly number[], DeploymentError>>;
}

export type StackStatus = 'deploying' | 'running' | 'failed';

/** One public domain in front of one container port. */
export interface StackRoute {
  readonly domain: string;
  readonly service: string;
  readonly containerPort: number;
  /** Published on 127.0.0.1 only; Nginx proxies the domain to it. */
  readonly hostPort: number;
  readonly cloudflareCredentialId: string | null;
  readonly cloudflareZoneId: string | null;
  /** Orange cloud or DNS only for a new record; null follows the Cloudflare settings. */
  readonly proxied: boolean | null;
  readonly https: boolean;
  /** Largest request Nginx accepts, e.g. `100m`. */
  readonly clientMaxBodySize: string;
}

/** What CloudForge remembers about a stack. The file and `.env` live in `credentialId`. */
export interface StackRecord {
  readonly id: string;
  readonly targetId: string;
  readonly name: string;
  /** Encrypted `docker-stack` credential holding the Compose file and the `.env`. */
  readonly credentialId: string;
  readonly routes: readonly StackRoute[];
  readonly certificateEmail: string | null;
  readonly services: readonly string[];
  readonly externalNetworks: readonly string[];
  readonly externalVolumes: readonly string[];
  readonly status: StackStatus;
  /** Problems that did not stop the stack, e.g. HTTPS not issued yet. */
  readonly warnings: readonly string[];
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Project-scoped persistence for stack records. */
export interface StackStore {
  list(): Promise<Result<StackRecord[], PersistenceError>>;
  save(record: StackRecord): Promise<Result<void, PersistenceError>>;
  remove(id: string): Promise<Result<void, PersistenceError>>;
}
