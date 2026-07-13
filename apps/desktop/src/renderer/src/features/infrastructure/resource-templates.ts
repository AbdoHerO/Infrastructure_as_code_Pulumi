import type { ResourceKind, ResourceSpec } from '@cloudforge/core';

/** A blank resource of a given kind, with sensible defaults. */
export function createResource(kind: ResourceKind, name: string): ResourceSpec {
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
        shape: 'VM.Standard.E4.Flex',
        image: 'ubuntu-22.04',
        subnetName: 'subnet',
        sshPublicKey: '',
        assignPublicIp: true,
      };
    case 'volume':
      return { kind, name, sizeGb: 50 };
    default:
      return { kind: 'network', name, cidrBlock: '10.0.0.0/16' };
  }
}

/** Kinds offered in the "add resource" menu, in a sensible order. */
export const ADDABLE_KINDS: readonly { kind: ResourceKind; label: string }[] = [
  { kind: 'network', label: 'Network (VCN)' },
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
