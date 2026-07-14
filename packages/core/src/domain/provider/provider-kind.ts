/**
 * Every cloud provider the architecture is designed to support. Oracle Cloud is
 * implemented first; the rest are added by implementing the `CloudProvider`
 * interface — no other part of the system changes.
 */
export const PROVIDER_KINDS = [
  'oracle',
  'aws',
  'azure',
  'gcp',
  'hetzner',
  'digitalocean',
  'vultr',
  'linode',
  'ovh',
  'scaleway',
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Providers whose infrastructure engine is enabled for Preview/Apply. */
export const PROVISIONING_PROVIDER_KINDS = ['oracle'] as const satisfies readonly ProviderKind[];
export type ProvisioningProviderKind = (typeof PROVISIONING_PROVIDER_KINDS)[number];

export function isProvisioningProviderKind(value: string): value is ProvisioningProviderKind {
  return (PROVISIONING_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** Human-readable labels for provider kinds. */
export const PROVIDER_LABELS: Readonly<Record<ProviderKind, string>> = {
  oracle: 'Oracle Cloud',
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  gcp: 'Google Cloud',
  hetzner: 'Hetzner',
  digitalocean: 'DigitalOcean',
  vultr: 'Vultr',
  linode: 'Linode',
  ovh: 'OVH',
  scaleway: 'Scaleway',
};

/** Type guard for a valid {@link ProviderKind}. */
export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}
