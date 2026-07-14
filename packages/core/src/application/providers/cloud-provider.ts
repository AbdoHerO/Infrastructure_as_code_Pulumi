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

/** A provider machine image suitable for launching compute instances. */
export interface MachineImage {
  readonly id: string;
  readonly name: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly owner?: string;
  readonly createdAt?: string;
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

export type InstanceAction = 'start' | 'stop' | 'reboot';

export interface CloudResource {
  readonly id: string;
  readonly name: string;
  readonly type: 'vcn' | 'subnet' | 'internet-gateway' | 'volume';
  readonly state: string;
  readonly region: string;
  readonly details?: string;
}

export type FirewallProtocol = 'tcp' | 'udp' | 'icmp' | 'all';
export type FirewallDirection = 'ingress' | 'egress';
export interface LiveFirewallRule {
  readonly id: string;
  readonly direction: FirewallDirection;
  readonly protocol: FirewallProtocol;
  readonly cidr: string;
  readonly portFrom: number | null;
  readonly portTo: number | null;
  readonly description: string;
  readonly stateless: boolean;
}
export interface InstanceFirewall {
  readonly provider: ProviderKind;
  readonly instanceId: string;
  readonly instanceName: string;
  readonly state: string;
  readonly subnetId: string;
  readonly subnetName: string;
  readonly securityListId: string;
  readonly publicIp: string | null;
  readonly privateIp: string | null;
  readonly rules: readonly LiveFirewallRule[];
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

  /** Optional provider capability for discovering launchable machine images. */
  listImages?(): Promise<Result<MachineImage[], ProviderError>>;

  /** List instances even when they were created outside CloudForge. */
  listInstances(): Promise<Result<CloudInstance[], ProviderError>>;

  /** Permanently terminate an instance and its boot volume. */
  terminateInstance(instanceId: string): Promise<Result<void, ProviderError>>;

  /** Start, stop or reboot an existing compute instance and wait for completion. */
  instanceAction(
    instanceId: string,
    action: InstanceAction,
  ): Promise<Result<CloudInstance, ProviderError>>;

  /** Discover supported non-compute resources in the configured compartment. */
  listResources(): Promise<Result<CloudResource[], ProviderError>>;

  /** Optional provider capability for in-place instance firewall management. */
  getInstanceFirewall?(instanceId: string): Promise<Result<InstanceFirewall, ProviderError>>;
  updateInstanceFirewall?(
    instanceId: string,
    rules: readonly LiveFirewallRule[],
  ): Promise<Result<InstanceFirewall, ProviderError>>;
}
