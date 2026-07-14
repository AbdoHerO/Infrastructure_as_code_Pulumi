/**
 * A provider-agnostic, declarative description of desired infrastructure. The
 * Application layer builds a plan from a project's configuration; the Pulumi
 * engine (Infrastructure layer) interprets it into concrete cloud resources.
 * No Pulumi or provider type ever appears here.
 */

/** Kinds of infrastructure resource the platform can declare. */
export const RESOURCE_KINDS = [
  'network',
  'subnet',
  'firewall',
  'compute',
  'volume',
  'loadBalancer',
  'dns',
  'objectStorage',
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

interface BaseResource {
  /** Stable logical name, unique within a plan. */
  readonly name: string;
  readonly kind: ResourceKind;
}

export interface NetworkResource extends BaseResource {
  readonly kind: 'network';
  readonly cidrBlock: string;
}

export interface SubnetResource extends BaseResource {
  readonly kind: 'subnet';
  readonly networkName: string;
  readonly cidrBlock: string;
  readonly public: boolean;
}

export interface FirewallRule {
  readonly protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  readonly port?: number | undefined;
  readonly source: string;
  readonly direction: 'ingress' | 'egress';
}

export interface FirewallResource extends BaseResource {
  readonly kind: 'firewall';
  readonly networkName: string;
  readonly rules: readonly FirewallRule[];
}

export interface ComputeResource extends BaseResource {
  readonly kind: 'compute';
  /** OCI compute shape, e.g. `VM.Standard.E4.Flex` or `VM.Standard.E2.1.Micro`. */
  readonly shape: string;
  /** Either an OS identifier (`ubuntu-22.04`) resolved live, or an image OCID. */
  readonly image: string;
  readonly subnetName: string;
  readonly sshPublicKey: string;
  /** Encrypted CloudForge SSH credential whose public key is installed. */
  readonly sshCredentialId?: string | undefined;
  readonly assignPublicIp: boolean;
  /** vCPUs for flexible shapes (ignored by fixed shapes). Defaults to 1. */
  readonly ocpus?: number | undefined;
  /** Memory in GB for flexible shapes (ignored by fixed shapes). Defaults to 6. */
  readonly memoryGb?: number | undefined;
  /** Boot volume size in GB. Omit to use the image default (~47 GB). */
  readonly bootVolumeGb?: number | undefined;
  /** Availability domain name. Omit to use the compartment's first AD. */
  readonly availabilityDomain?: string | undefined;
}

export interface VolumeResource extends BaseResource {
  readonly kind: 'volume';
  readonly sizeGb: number;
  readonly attachTo?: string;
}

export type ResourceSpec =
  NetworkResource | SubnetResource | FirewallResource | ComputeResource | VolumeResource;

/** Full declarative plan for one stack (one project's infrastructure). */
export interface InfrastructurePlan {
  readonly providerKind: string;
  /** Provider configuration (region, compartment, …) — non-secret settings. */
  readonly config: Readonly<Record<string, string>>;
  readonly resources: readonly ResourceSpec[];
}

/** A single validation problem found in a plan. */
export interface PlanIssue {
  readonly resource: string;
  readonly message: string;
}

/**
 * Validate the internal consistency of a plan (unique names, resolvable
 * references) before it reaches the engine. Pure and fully unit-testable.
 */
export function validatePlan(plan: InfrastructurePlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const names = new Set<string>();
  const networks = new Set<string>();
  const subnets = new Set<string>();

  for (const resource of plan.resources) {
    if (names.has(resource.name)) {
      issues.push({ resource: resource.name, message: 'Duplicate resource name' });
    }
    names.add(resource.name);
    if (resource.kind === 'network') networks.add(resource.name);
    if (resource.kind === 'subnet') subnets.add(resource.name);
  }

  for (const resource of plan.resources) {
    if (resource.kind === 'subnet' && !networks.has(resource.networkName)) {
      issues.push({
        resource: resource.name,
        message: `Unknown network "${resource.networkName}"`,
      });
    }
    if (resource.kind === 'firewall' && !networks.has(resource.networkName)) {
      issues.push({
        resource: resource.name,
        message: `Unknown network "${resource.networkName}"`,
      });
    }
    if (resource.kind === 'compute' && !subnets.has(resource.subnetName)) {
      issues.push({ resource: resource.name, message: `Unknown subnet "${resource.subnetName}"` });
    }
  }

  return issues;
}
