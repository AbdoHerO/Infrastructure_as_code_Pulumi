import type { ResourceSpec } from './infrastructure-plan.js';

/** The two fields needed to tie a saved SSH key to a compute resource. */
export interface SshKeyReference {
  readonly id: string;
  readonly publicKey: string;
}

/** Provider-independent SSH connection information exposed by an infrastructure stack. */
export interface SshConnectionHint {
  readonly resourceName: string;
  readonly host: string;
  readonly user: string;
}

/**
 * Extract SSH connection hints from the stable stack-output convention shared by
 * infrastructure adapters: `<resourceName>PublicIp` and `<resourceName>SshUser`.
 */
export function extractSshConnectionHints(
  outputs: Readonly<Record<string, unknown>>,
): SshConnectionHint[] {
  const connections: SshConnectionHint[] = [];
  for (const [key, value] of Object.entries(outputs)) {
    if (!key.endsWith('PublicIp') || typeof value !== 'string') continue;
    const resourceName = key.slice(0, -'PublicIp'.length);
    const user = outputs[`${resourceName}SshUser`];
    const host = value.trim();
    if (!resourceName || typeof user !== 'string' || !isSafeHost(host) || !isSafeUser(user)) {
      continue;
    }
    connections.push({ resourceName, host, user });
  }
  return connections;
}

/**
 * The SSH connections a stack exposes, each with the managed key its compute
 * resource was created with, when CloudForge holds that key.
 */
export function matchSshConnections<Key extends SshKeyReference>(
  outputs: Readonly<Record<string, unknown>>,
  resources: readonly ResourceSpec[],
  keys: readonly Key[],
): (SshConnectionHint & { readonly sshKey?: Key })[] {
  return extractSshConnectionHints(outputs).map((connection) => {
    const compute = resources.find(
      (resource) => resource.kind === 'compute' && resource.name === connection.resourceName,
    );
    const sshKey =
      compute?.kind === 'compute'
        ? keys.find(
            (key) =>
              key.id === compute.sshCredentialId ||
              key.publicKey.trim() === compute.sshPublicKey.trim(),
          )
        : undefined;
    return { ...connection, ...(sshKey ? { sshKey } : {}) };
  });
}

/** Build a copyable OpenSSH command without allowing stack outputs to inject shell syntax. */
export function formatSshCommand(connection: SshConnectionHint, identityFile?: string): string {
  const identity = identityFile ? `-i "${identityFile.replaceAll('"', '\\"')}" ` : '';
  return `ssh ${identity}${connection.user}@${connection.host}`;
}

function isSafeUser(value: string): boolean {
  return /^[a-z_][a-z0-9_-]*$/i.test(value);
}

function isSafeHost(value: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[0-9a-f:]+)$/i.test(value);
}
