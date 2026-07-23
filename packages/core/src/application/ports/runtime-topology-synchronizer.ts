import type {
  ConflictError,
  DeploymentError,
  NotFoundError,
  PersistenceError,
  Result,
  ValidationError,
} from '@cloudforge/shared';
import type { ExposureMode } from '../vps-runtime/runtime-ownership.js';

export type RuntimeTopologySyncError =
  ValidationError | ConflictError | NotFoundError | PersistenceError | DeploymentError;

export interface RuntimeApplicationSync {
  readonly targetId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly displayName: string;
  readonly composeProject: string;
  readonly deploymentMode: 'scm' | 'inline' | 'compose' | 'external';
  readonly repositoryUrl?: string;
  readonly branch?: string;
  readonly hostPort: number | null;
  readonly applicationPort: number | null;
  readonly exposure: ExposureMode;
  readonly ownership: 'cloudforge-managed' | 'adopted' | 'unmanaged';
}

export interface RuntimeRouteSync {
  readonly sourceId: string;
  readonly domain: string;
  readonly path: string;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly websocket: boolean;
  readonly tls: boolean;
  readonly httpRedirect: boolean;
  readonly ownership: 'cloudforge-managed' | 'adopted' | 'unmanaged';
}

export interface RuntimeCertificateSync {
  readonly targetId: string;
  readonly sourceId: string;
  /** Certificate store/volume whose inventory produced this observation. */
  readonly collectionId: string;
  readonly domain: string;
  readonly authority: 'letsencrypt' | 'cloudflare-origin-ca' | 'unknown';
  readonly status: 'valid' | 'expiring' | 'expired' | 'missing' | 'unknown';
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly httpsEnabled: boolean;
  readonly httpRedirect: boolean;
  readonly fingerprint?: string;
  readonly ownership: 'cloudforge-managed' | 'adopted' | 'unmanaged';
  readonly observedAt: string;
}

export interface RuntimeDnsRecordSync {
  readonly targetId?: string;
  readonly sourceId: string;
  readonly recordId: string;
  readonly zoneId: string;
  readonly domain: string;
  readonly type: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly status: 'active' | 'pending' | 'error' | 'unknown';
  readonly ownership: 'cloudforge-managed' | 'adopted' | 'unmanaged';
  readonly observedAt: string;
}

/**
 * Cross-feature write port for the authoritative runtime plan.
 *
 * Feature services know what succeeded; they do not know how runtime plans are
 * stored, versioned, validated, or reconciled. The desktop supplies the
 * existing RuntimePlanService as this port.
 */
export interface RuntimeTopologySynchronizer {
  upsertApplication(input: RuntimeApplicationSync): Promise<Result<void, RuntimeTopologySyncError>>;
  removeApplication(
    targetId: string,
    sourceId: string,
  ): Promise<Result<void, RuntimeTopologySyncError>>;
  replaceRoutes(
    targetId: string,
    routes: readonly RuntimeRouteSync[],
  ): Promise<Result<void, RuntimeTopologySyncError>>;
  upsertRoute(
    targetId: string,
    route: RuntimeRouteSync,
  ): Promise<Result<void, RuntimeTopologySyncError>>;
  removeRoute(targetId: string, sourceId: string): Promise<Result<void, RuntimeTopologySyncError>>;
  replaceCertificates(
    targetId: string,
    collectionId: string,
    certificates: readonly RuntimeCertificateSync[],
  ): Promise<Result<void, RuntimeTopologySyncError>>;
  upsertCertificate(
    certificate: RuntimeCertificateSync,
  ): Promise<Result<void, RuntimeTopologySyncError>>;
  upsertDnsRecord(record: RuntimeDnsRecordSync): Promise<Result<void, RuntimeTopologySyncError>>;
  replaceDnsRecords(
    zoneId: string,
    records: readonly RuntimeDnsRecordSync[],
  ): Promise<Result<void, RuntimeTopologySyncError>>;
  removeDnsRecord(
    sourceId: string,
    targetId?: string,
  ): Promise<Result<void, RuntimeTopologySyncError>>;
}

/** Finds saved VPS targets for service resources that only carry an address. */
export interface RuntimeTargetCatalog {
  findTargetIdByAddress(address: string): Promise<string | null>;
  targetIds(): Promise<readonly string[]>;
}
