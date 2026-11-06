import type { ResourceKind, ResourceSpec } from './infrastructure-plan.js';

/**
 * Defaults for a new plan resource.
 *
 * Lives in the Application layer because both the plan editor and an API client
 * start from the same blank resource: a default chosen in only one of them would
 * make the same "add a compute instance" mean two different things.
 */
export function createResource(
  kind: ResourceKind,
  name: string,
  providerKind = 'oracle',
): ResourceSpec {
  switch (kind) {
    case 'network':
      return { kind, name, cidrBlock: '10.0.0.0/16' };
    case 'subnet':
      return { kind, name, networkName: 'network', cidrBlock: '10.0.1.0/24', public: true };
    case 'firewall':
      return {
        kind,
        name,
        networkName: 'network',
        rules: [
          { protocol: 'tcp', port: 22, source: '0.0.0.0/0', direction: 'ingress' },
          { protocol: 'tcp', port: 80, source: '0.0.0.0/0', direction: 'ingress' },
        ],
      };
    case 'compute':
      return {
        kind,
        name,
        shape: providerKind === 'aws' ? 't3.micro' : 'VM.Standard.E2.1.Micro',
        image: providerKind === 'aws' ? 'ubuntu-24.04' : 'ubuntu-22.04',
        subnetName: 'subnet',
        sshPublicKey: '',
        assignPublicIp: true,
        bootVolumeGb: providerKind === 'aws' ? 30 : 50,
        availabilityDomain: '',
      };
    case 'volume':
      return { kind, name, sizeGb: 50, attachTo: '' };
    default:
      return { kind: 'network', name, cidrBlock: '10.0.0.0/16' };
  }
}

/** Kinds a plan can actually provision, in a sensible order. */
export const ADDABLE_KINDS: readonly { kind: ResourceKind; label: string }[] = [
  { kind: 'network', label: 'Network (VCN/VPC)' },
  { kind: 'subnet', label: 'Subnet' },
  { kind: 'firewall', label: 'Firewall' },
  { kind: 'compute', label: 'Compute instance' },
  { kind: 'volume', label: 'Block volume' },
];

/** Ensure a unique resource name within the current set. */
export function uniqueName(existing: readonly ResourceSpec[], base: string): string {
  const names = new Set(existing.map((r) => r.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/** Curated shapes used when an account's live values are not available. */
export const FALLBACK_SHAPES: Readonly<Record<string, readonly string[]>> = {
  oracle: [
    'VM.Standard.E2.1.Micro',
    'VM.Standard.A1.Flex',
    'VM.Standard.E3.Flex',
    'VM.Standard.E4.Flex',
    'VM.Standard.E5.Flex',
  ],
  aws: ['t3.micro', 't3.small', 't4g.micro', 't4g.small'],
};

/** Operating systems a compute resource can name instead of an image id. */
export const OS_IMAGES: readonly string[] = [
  'ubuntu-22.04',
  'ubuntu-24.04',
  'ubuntu-20.04',
  'oracle-linux-9',
  'oracle-linux-8',
  'amazon-linux-2023',
];

export interface InfrastructureResourcePresets {
  readonly providerKind: string;
  readonly kinds: readonly { readonly kind: ResourceKind; readonly label: string }[];
  /** One blank resource per kind, ready to rename and adjust. */
  readonly defaults: readonly ResourceSpec[];
  readonly shapes: readonly string[];
  readonly images: readonly string[];
}

/** Everything needed to write a plan without first reading the plan editor. */
export function infrastructureResourcePresets(
  providerKind = 'oracle',
): InfrastructureResourcePresets {
  return {
    providerKind,
    kinds: ADDABLE_KINDS,
    defaults: ADDABLE_KINDS.map(({ kind }) => createResource(kind, kind, providerKind)),
    shapes: FALLBACK_SHAPES[providerKind] ?? [],
    images: OS_IMAGES,
  };
}
