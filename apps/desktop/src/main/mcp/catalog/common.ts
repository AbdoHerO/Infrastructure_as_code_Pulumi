import { z } from 'zod/v4';
import type { SshTargetRequest } from '../../../shared/ipc/contract.js';
import { type McpCallContext, type McpSessionState, McpToolError } from '../types.js';

export const id = (what: string): z.ZodString => z.string().min(1).describe(what);

export const targetId = id('Saved VPS target id, from targets_list');
export const credentialId = id('Credential id, from credentials_list');
export const zoneId = id('Cloudflare zone id, from cloudflare_list_zones');
export const port = z.number().int().min(1).max(65535);
export const portsList = z
  .array(z.object({ port, protocol: z.enum(['tcp', 'udp']) }))
  .min(1)
  .describe('Ports, each with its protocol');

/** Fingerprints stay trusted for this long after the server itself read them. */
const HOST_KEY_MEMORY_MS = 10 * 60_000;

const hostKey = (host: string, portNumber: number): string =>
  `${host.trim().toLowerCase()}:${String(portNumber)}`;

export function rememberHostKey(
  session: McpSessionState,
  host: string,
  portNumber: number,
  fingerprint: string,
  now: number,
): void {
  session.inspectedHostKeys.set(hostKey(host, portNumber), { fingerprint, at: now });
}

/**
 * A fingerprint is what SSH trusts, so a client may only pin one this server has
 * just read from that host. Otherwise whoever writes the tool call would also
 * choose which machine counts as genuine.
 */
export function requireInspectedHostKey(
  context: McpCallContext,
  host: string,
  portNumber: number,
  fingerprint: string,
  inspectTool: string,
): void {
  const known = context.session.inspectedHostKeys.get(hostKey(host, portNumber));
  if (!known || context.now() - known.at > HOST_KEY_MEMORY_MS) {
    throw new McpToolError(
      `Call ${inspectTool} for ${host}:${String(portNumber)} first, and check the fingerprint it returns.`,
    );
  }
  if (known.fingerprint !== fingerprint) {
    throw new McpToolError(
      `That is not the fingerprint ${host}:${String(portNumber)} presented. Call ${inspectTool} again and use what it returns.`,
    );
  }
}

/** The connection details of a saved target, loaded here and never taken from the caller. */
export async function savedTarget(
  context: McpCallContext,
  id: string,
): Promise<SshTargetRequest & { targetId: string }> {
  const target = await context.call('ansible:getTarget', { id });
  if (!target.sshCredentialId) {
    throw new McpToolError(`The saved target "${target.name}" has no SSH credential.`);
  }
  return {
    targetId: target.id,
    host: target.host,
    port: target.port,
    username: target.username,
    sshCredentialId: target.sshCredentialId,
    hostKeySha256: target.hostKeySha256,
  };
}

/** Variable names of an `.env` file, without its values. */
export function environmentVariableNames(environment: string): string[] {
  return environment.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
}
