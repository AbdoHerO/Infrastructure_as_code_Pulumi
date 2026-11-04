import type { DeploymentError, PersistenceError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

/** Everything the server needs to bring one WordPress site up. */
export interface WordPressDeployment {
  /** Compose project, `cloudforge-wp-<slug>`; also the directory and container prefix. */
  readonly project: string;
  readonly composeYaml: string;
  /** PHP settings mounted into the WordPress container (upload size, memory). */
  readonly phpIni: string;
  readonly hostPort: number;
  readonly siteUrl: string;
  readonly siteTitle: string;
  readonly adminUser: string;
  readonly adminEmail: string;
  /**
   * Never placed in a script or on a command line: the adapter uploads them as
   * owner-only files and the server moves them into place.
   */
  readonly secrets: {
    readonly databasePassword: string;
    readonly databaseRootPassword: string;
    readonly adminPassword: string;
  };
}

export interface WordPressContainerState {
  readonly service: string;
  readonly name: string;
  readonly state: string;
  readonly health: string;
  readonly image: string;
}

export interface WordPressRuntimeStatus {
  readonly project: string;
  readonly containers: readonly WordPressContainerState[];
  /** WordPress core version read from the site's files, null when unreadable. */
  readonly wordpressVersion: string | null;
  readonly installed: boolean;
}

export interface WordPressEvent {
  readonly stream: 'step' | 'stdout' | 'stderr' | 'error';
  readonly message: string;
}
export type WordPressEventSink = (event: WordPressEvent) => void;

/** Remote side of a WordPress site: one Docker Compose project per site. */
export interface WordPressManager {
  deploy(
    target: DeploymentTarget,
    deployment: WordPressDeployment,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressRuntimeStatus, DeploymentError>>;
  /** Pull the latest images, recreate the containers and update WordPress core. */
  update(
    target: DeploymentTarget,
    project: string,
    onEvent?: WordPressEventSink,
  ): Promise<Result<WordPressRuntimeStatus, DeploymentError>>;
  status(
    target: DeploymentTarget,
    project: string,
  ): Promise<Result<WordPressRuntimeStatus, DeploymentError>>;
  /** Stop and remove the containers; with `deleteData` also the volumes and files. */
  remove(
    target: DeploymentTarget,
    project: string,
    deleteData: boolean,
    onEvent?: WordPressEventSink,
  ): Promise<Result<void, DeploymentError>>;
}

export type WordPressSiteStatus = 'deploying' | 'running' | 'failed';

/** What CloudForge remembers about a site. Secrets live in `credentialId`. */
export interface WordPressSiteRecord {
  readonly id: string;
  readonly targetId: string;
  readonly domain: string;
  readonly project: string;
  readonly siteTitle: string;
  readonly adminUser: string;
  readonly adminEmail: string;
  readonly hostPort: number;
  /** Environment-file credential holding the database and admin passwords. */
  readonly credentialId: string;
  readonly cloudflareCredentialId: string | null;
  readonly cloudflareZoneId: string | null;
  readonly https: boolean;
  readonly certificateEmail: string | null;
  readonly status: WordPressSiteStatus;
  readonly wordpressVersion: string | null;
  /** Problems that did not stop the site, e.g. HTTPS not issued yet. */
  readonly warnings: readonly string[];
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Project-scoped persistence for WordPress site records. */
export interface WordPressSiteStore {
  list(): Promise<Result<WordPressSiteRecord[], PersistenceError>>;
  save(record: WordPressSiteRecord): Promise<Result<void, PersistenceError>>;
  remove(id: string): Promise<Result<void, PersistenceError>>;
}
