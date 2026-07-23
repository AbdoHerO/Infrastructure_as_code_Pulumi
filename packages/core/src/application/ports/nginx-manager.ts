import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

export type NginxInstallation = 'native' | 'docker' | 'not-installed';
export type NginxConfigStatus = 'valid' | 'invalid' | 'unknown';

export interface NginxOverview {
  readonly version: string | null;
  readonly running: boolean;
  readonly enabled: boolean;
  readonly installation: NginxInstallation;
  readonly configStatus: NginxConfigStatus;
  readonly configMessage: string;
  readonly siteCount: number;
  readonly sslDomainCount: number;
  readonly lastReloadAt: string | null;
  readonly lastReloadSucceeded: boolean | null;
}

export interface NginxHeader {
  readonly name: string;
  readonly value: string;
}
export interface NginxLocation {
  readonly path: string;
  readonly upstreamHost?: string;
  readonly upstreamPort?: number;
  readonly websocket?: boolean;
  readonly proxyTimeoutSeconds?: number;
  readonly extraDirectives?: readonly string[];
}

export interface ManagedNginxSite {
  readonly managed?: boolean;
  readonly configPath?: string;
  readonly domain: string;
  readonly enabled: boolean;
  readonly upstreamKind: 'host' | 'docker';
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly websocket: boolean;
  readonly ssl: boolean;
  readonly certificatePath?: string;
  readonly acmeWebroot?: string;
  readonly httpRedirect: boolean;
  readonly headers: readonly NginxHeader[];
  readonly extraDirectives: readonly string[];
  readonly locations: readonly NginxLocation[];
  readonly proxyTimeoutSeconds: number;
  readonly clientMaxBodySize: string;
  readonly compression: boolean;
  readonly cache: boolean;
  readonly customSnippets: readonly string[];
  readonly lastModified: string | null;
}

export interface NginxLiveStatus {
  readonly workers: number | null;
  readonly activeConnections: number | null;
  readonly acceptedConnections: number | null;
  readonly handledConnections: number | null;
  readonly requests: number | null;
  readonly reloadCount: number;
  readonly recentErrors: number;
}

export interface NginxLogQuery {
  readonly kind: 'access' | 'error';
  readonly search?: string;
  readonly limit?: number;
}

export interface NginxBackup {
  readonly id: string;
  readonly createdAt: string;
  readonly reason: string;
}

export interface NginxOperationOutcome {
  readonly summary: string;
  readonly backupId?: string;
}

export interface NginxEvent {
  readonly stream: 'stdout' | 'stderr' | 'step' | 'error';
  readonly message: string;
}
export type NginxEventSink = (event: NginxEvent) => void;

/** Provider-independent remote Nginx adapter. */
export interface NginxManager {
  inspect(target: DeploymentTarget): Promise<Result<NginxOverview, DeploymentError>>;
  listSites(target: DeploymentTarget): Promise<Result<ManagedNginxSite[], DeploymentError>>;
  applySite(
    target: DeploymentTarget,
    site: ManagedNginxSite,
    renderedConfig: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>>;
  removeSite(
    target: DeploymentTarget,
    domain: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>>;
  readMainConfig(target: DeploymentTarget): Promise<Result<string, DeploymentError>>;
  saveMainConfig(
    target: DeploymentTarget,
    content: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>>;
  reload(
    target: DeploymentTarget,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>>;
  liveStatus(target: DeploymentTarget): Promise<Result<NginxLiveStatus, DeploymentError>>;
  readLogs(
    target: DeploymentTarget,
    query: NginxLogQuery,
  ): Promise<Result<string[], DeploymentError>>;
  listBackups(target: DeploymentTarget): Promise<Result<NginxBackup[], DeploymentError>>;
  readBackupConfig(
    target: DeploymentTarget,
    backupId: string,
  ): Promise<Result<string, DeploymentError>>;
  restore(
    target: DeploymentTarget,
    backupId: string,
    onEvent?: NginxEventSink,
  ): Promise<Result<NginxOperationOutcome, DeploymentError>>;
}
