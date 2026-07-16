import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

export interface CertificateIssueConfig {
  readonly domain: string;
  readonly email: string;
  readonly certificateVolume: string;
  readonly webrootVolume: string;
  readonly forceRenewal: boolean;
  readonly authority?: 'letsencrypt' | 'cloudflare-origin-ca';
  readonly cloudflareCredentialId?: string;
  readonly includeWildcard?: boolean;
  readonly keyAlgorithm?: 'rsa' | 'ecc';
  readonly validityDays?: 7 | 30 | 90 | 365 | 730 | 1095 | 5475;
}
export interface OriginCertificateSigningRequest {
  readonly csr: string;
  readonly workspace: string;
}
export interface CertificateDetails {
  readonly domain: string;
  readonly issuer: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly daysRemaining: number;
  readonly sans: readonly string[];
  readonly wildcard: boolean;
  readonly keyAlgorithm: string;
  readonly fingerprint: string;
}
export interface CertificateEvent {
  readonly stream: 'step' | 'stdout' | 'stderr' | 'error';
  readonly message: string;
}
export type CertificateEventSink = (event: CertificateEvent) => void;

export interface DomainResolver {
  resolve(domain: string): Promise<Result<readonly string[], DeploymentError>>;
}
export interface ManagedDnsCoordinator {
  ensure(
    domain: string,
    expectedIp: string,
    credentialId?: string,
    zoneId?: string,
  ): Promise<
    Result<
      { readonly status: 'pending' | 'propagated' | 'error'; readonly warning: string | null },
      unknown
    >
  >;
  verify?(
    domain: string,
    expectedIp: string,
    credentialId?: string,
    zoneId?: string,
  ): Promise<
    Result<
      {
        readonly status: 'pending' | 'propagated' | 'error';
        readonly warning: string | null;
        readonly current: string;
        readonly proxied: boolean;
        readonly publicAnswers: readonly string[];
        readonly sslMode: string;
        readonly certificateRequirement: 'required' | 'recommended';
      },
      unknown
    >
  >;
}
export interface CertificateManager {
  issue(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, DeploymentError>>;
  list(
    target: DeploymentTarget,
    certificateVolume: string,
  ): Promise<Result<CertificateDetails[], DeploymentError>>;
  renew(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, DeploymentError>>;
  prepareOriginCertificate(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    hostnames: readonly string[],
    onEvent?: CertificateEventSink,
  ): Promise<Result<OriginCertificateSigningRequest, DeploymentError>>;
  installOriginCertificate(
    target: DeploymentTarget,
    config: CertificateIssueConfig,
    workspace: string,
    certificate: string,
    onEvent?: CertificateEventSink,
  ): Promise<Result<CertificateDetails, DeploymentError>>;
  discardOriginCertificate(
    target: DeploymentTarget,
    workspace: string,
  ): Promise<Result<void, DeploymentError>>;
  export(
    target: DeploymentTarget,
    certificateVolume: string,
    domain: string,
    format: 'pem' | 'crt' | 'key' | 'zip',
  ): Promise<Result<{ name: string; contentBase64: string }, DeploymentError>>;
}
