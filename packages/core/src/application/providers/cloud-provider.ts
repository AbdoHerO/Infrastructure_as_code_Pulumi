import type { ProviderError, Result } from '@cloudforge/shared';
import type { ProviderKind } from '../../domain/provider/provider-kind.js';

/** A cloud region a provider operates in. */
export interface Region {
  readonly id: string;
  readonly name: string;
  readonly isHome?: boolean;
}

/** An availability domain / zone within a region. */
export interface AvailabilityDomain {
  readonly id: string;
  readonly name: string;
}

/** A compute shape / instance type offered by a provider. */
export interface Shape {
  readonly id: string;
  readonly name: string;
  readonly ocpus?: number;
  readonly memoryGb?: number;
}

/** A compute instance discovered directly from the provider account. */
export interface CloudInstance {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly shape: string;
  readonly availabilityDomain: string;
  readonly region: string;
  readonly createdAt?: string;
}

/** Basic account/tenancy information shown after a successful connection. */
export interface AccountInfo {
  readonly accountId: string;
  readonly name: string;
  readonly email?: string;
  readonly homeRegion?: string;
}

/** Outcome of a connection test. */
export interface ConnectionTestResult {
  readonly connected: boolean;
  readonly message: string;
  readonly account?: AccountInfo;
}

/**
 * The provider-independent capability contract. Adding support for a new cloud
 * is implementing this one interface — no provider-specific logic ever leaks
 * into the Application or Presentation layers.
 *
 * Infrastructure mutation (create/delete VMs, networks, …) is layered on in
 * Phase 7 via capability interfaces that extend this base.
 */
export interface CloudProvider {
  readonly kind: ProviderKind;

  /** Verify the credentials and report reachability + account info. */
  testConnection(): Promise<Result<ConnectionTestResult, ProviderError>>;

  /** Fetch account/tenancy information. */
  getAccountInfo(): Promise<Result<AccountInfo, ProviderError>>;

  /** List the regions available to this account. */
  listRegions(): Promise<Result<Region[], ProviderError>>;

  /** List availability domains for the active (or given) region. */
  listAvailabilityDomains(): Promise<Result<AvailabilityDomain[], ProviderError>>;

  /** List the compute shapes available to this account. */
  listShapes(): Promise<Result<Shape[], ProviderError>>;

  /** List instances even when they were created outside CloudForge. */
  listInstances(): Promise<Result<CloudInstance[], ProviderError>>;

  /** Permanently terminate an instance and its boot volume. */
  terminateInstance(instanceId: string): Promise<Result<void, ProviderError>>;
}
