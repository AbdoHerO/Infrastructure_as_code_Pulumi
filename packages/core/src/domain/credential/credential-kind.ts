/** The kinds of credential CloudForge can store, one per external service. */
export const CREDENTIAL_KINDS = [
  'oracle',
  'aws',
  'azure',
  'github',
  'cloudflare',
  'openai',
  'anthropic',
  'dockerhub',
  'gitlab',
  'ssh',
  'ssh-password',
] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Descriptor for a single field within a credential kind. */
export interface CredentialFieldSpec {
  readonly key: string;
  readonly label: string;
  /** Secret fields are masked in the UI and only revealed on explicit request. */
  readonly secret: boolean;
  readonly required: boolean;
  /** Render hint for the field: single-line vs multi-line (e.g. PEM keys). */
  readonly multiline?: boolean;
  readonly placeholder?: string;
}

/** Descriptor for a credential kind and its fields. */
export interface CredentialKindSpec {
  readonly kind: CredentialKind;
  readonly label: string;
  readonly fields: readonly CredentialFieldSpec[];
}

const field = (
  key: string,
  label: string,
  options: Partial<Omit<CredentialFieldSpec, 'key' | 'label'>> = {},
): CredentialFieldSpec => ({
  key,
  label,
  secret: options.secret ?? false,
  required: options.required ?? true,
  ...(options.multiline !== undefined ? { multiline: options.multiline } : {}),
  ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
});

/**
 * The single source of truth describing every credential kind and its fields.
 * Drives both dynamic form generation in the UI and validation in the domain,
 * so adding a provider's credentials is a declarative change here.
 */
export const CREDENTIAL_SCHEMAS: Readonly<Record<CredentialKind, CredentialKindSpec>> = {
  oracle: {
    kind: 'oracle',
    label: 'Oracle Cloud',
    fields: [
      field('tenancyOcid', 'Tenancy OCID', { placeholder: 'ocid1.tenancy.oc1..' }),
      field('userOcid', 'User OCID', { placeholder: 'ocid1.user.oc1..' }),
      field('compartmentOcid', 'Compartment OCID', { placeholder: 'ocid1.compartment.oc1..' }),
      field('fingerprint', 'Fingerprint', { placeholder: 'aa:bb:cc:..' }),
      field('privateKey', 'API Private Key (PEM)', { secret: true, multiline: true }),
      field('region', 'Region', { placeholder: 'eu-frankfurt-1' }),
      field('profileName', 'Profile Name', { required: false, placeholder: 'DEFAULT' }),
    ],
  },
  aws: {
    kind: 'aws',
    label: 'Amazon Web Services',
    fields: [
      field('accessKeyId', 'Access Key ID'),
      field('secretAccessKey', 'Secret Access Key', { secret: true }),
      field('sessionToken', 'Session Token', { secret: true, required: false }),
      field('region', 'Default Region', { placeholder: 'eu-west-1' }),
    ],
  },
  azure: {
    kind: 'azure',
    label: 'Microsoft Azure',
    fields: [
      field('subscriptionId', 'Subscription ID'),
      field('tenantId', 'Tenant ID'),
      field('clientId', 'Client ID'),
      field('clientSecret', 'Client Secret', { secret: true }),
    ],
  },
  github: {
    kind: 'github',
    label: 'GitHub',
    fields: [field('personalAccessToken', 'Personal Access Token', { secret: true })],
  },
  cloudflare: {
    kind: 'cloudflare',
    label: 'Cloudflare',
    fields: [
      field('apiToken', 'API Token', { secret: true }),
      field('accountId', 'Account ID', { required: false }),
      field('defaultZone', 'Default Zone', {
        required: false,
        placeholder: 'example.com or Zone ID',
      }),
    ],
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    fields: [field('apiKey', 'API Key', { secret: true, placeholder: 'sk-..' })],
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic',
    fields: [field('apiKey', 'API Key', { secret: true, placeholder: 'sk-ant-..' })],
  },
  dockerhub: {
    kind: 'dockerhub',
    label: 'Docker Hub',
    fields: [
      field('username', 'Username'),
      field('password', 'Password / Access Token', { secret: true }),
      field('registry', 'Registry', { required: false, placeholder: 'docker.io' }),
    ],
  },
  gitlab: {
    kind: 'gitlab',
    label: 'GitLab',
    fields: [field('token', 'Access Token', { secret: true })],
  },
  ssh: {
    kind: 'ssh',
    label: 'SSH Key',
    fields: [
      field('privateKey', 'Private Key (OpenSSH or PEM)', { secret: true, multiline: true }),
      field('passphrase', 'Passphrase', { secret: true, required: false }),
      field('publicKey', 'Public Key', { required: false, multiline: true }),
      field('fingerprint', 'Fingerprint', { required: false }),
      field('algorithm', 'Algorithm', { required: false }),
    ],
  },
  'ssh-password': {
    kind: 'ssh-password',
    label: 'SSH Password',
    fields: [field('password', 'Password', { secret: true })],
  },
};

/** Type guard for a valid {@link CredentialKind}. */
export function isCredentialKind(value: string): value is CredentialKind {
  return (CREDENTIAL_KINDS as readonly string[]).includes(value);
}
