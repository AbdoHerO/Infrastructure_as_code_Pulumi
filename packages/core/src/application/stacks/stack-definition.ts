import { err, ok, ValidationError, type Result } from '@cloudforge/shared';
import { isValidDomain, normalizeDomain } from '../domains/domain-publisher.js';
import type { ComposeAnalysis, StackRoute } from '../ports/stack-manager.js';

/** First local port offered for a route; each route binds one port on 127.0.0.1. */
export const STACK_FIRST_PORT = 8400;

/** Enough for most applications; Nginx refuses anything larger with a 413. */
export const STACK_DEFAULT_BODY_SIZE = '100m';

/** Docker Compose's rule for a project name. */
export const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const COMPOSE_MAX_BYTES = 512_000;
const ENVIRONMENT_MAX_BYTES = 1_000_000;
const BODY_SIZE = /^\d+(?:k|m|g)?$/i;
const EMAIL = /^[^\s@<>"'`\\]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface StackRouteInput {
  readonly domain: string;
  readonly service: string;
  readonly containerPort: number;
  /** Chosen automatically when absent. */
  readonly hostPort?: number | null;
  readonly cloudflareCredentialId?: string | null;
  readonly cloudflareZoneId?: string | null;
  readonly proxied?: boolean | null;
  readonly https: boolean;
  readonly clientMaxBodySize?: string | null;
}

export interface StackInput {
  readonly targetId: string;
  readonly name: string;
  readonly composeYaml: string;
  readonly environment: string;
  /** Empty for a stack that needs no public domain. */
  readonly routes: readonly StackRouteInput[];
  readonly certificateEmail?: string | null;
}

/** A route that passed validation, still waiting for its local port. */
export type ValidStackRoute = Omit<StackRoute, 'hostPort'> & { readonly hostPort: number | null };

export interface ValidStackInput {
  readonly targetId: string;
  readonly name: string;
  readonly composeYaml: string;
  readonly environment: string;
  readonly routes: readonly ValidStackRoute[];
  readonly certificateEmail: string | null;
}

function validPort(port: number, minimum: number): boolean {
  return Number.isInteger(port) && port >= minimum && port <= 65_535;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The Compose file and `.env` on their own, for creating and for editing a stack. */
export function validateStackFiles(
  composeYaml: string,
  environment: string,
  analysis: ComposeAnalysis,
): Result<void, ValidationError> {
  if (composeYaml.trim() === '') return err(new ValidationError('Paste the Compose file'));
  if (composeYaml.length > COMPOSE_MAX_BYTES)
    return err(new ValidationError('The Compose file must be 512 KB or smaller'));
  if (environment.length > ENVIRONMENT_MAX_BYTES)
    return err(new ValidationError('The .env file must be 1 MB or smaller'));
  if (analysis.errors.length > 0) return err(new ValidationError(analysis.errors.join(' ')));
  return ok(undefined);
}

export function validateStack(
  input: StackInput,
  analysis: ComposeAnalysis,
): Result<ValidStackInput, ValidationError> {
  const targetId = input.targetId.trim();
  if (!targetId) return err(new ValidationError('Choose the server for this stack'));
  const name = input.name.trim();
  if (!STACK_NAME_PATTERN.test(name))
    return err(
      new ValidationError(
        'The stack name needs lower-case letters, digits, - or _, and must start with a letter or digit',
      ),
    );
  const files = validateStackFiles(input.composeYaml, input.environment, analysis);
  if (!files.ok) return files;

  const routes: ValidStackRoute[] = [];
  const domains = new Set<string>();
  for (const route of input.routes) {
    const domain = normalizeDomain(route.domain);
    if (!isValidDomain(domain))
      return err(new ValidationError(`"${route.domain}" is not a valid domain name`));
    if (domains.has(domain))
      return err(new ValidationError(`${domain} is listed twice in this stack`));
    domains.add(domain);
    const service = analysis.services.find((item) => item.name === route.service);
    if (!service)
      return err(new ValidationError(`The Compose file has no service "${route.service}"`));
    if (service.hostNetwork)
      return err(
        new ValidationError(
          `Service "${service.name}" uses the host network, so ${domain} cannot be mapped to it`,
        ),
      );
    if (!validPort(route.containerPort, 1))
      return err(new ValidationError(`Enter the container port for ${domain} (1 to 65535)`));
    const hostPort = route.hostPort ?? null;
    if (hostPort !== null && !validPort(hostPort, 1024))
      return err(new ValidationError(`The local port for ${domain} must be 1024 to 65535`));
    const clientMaxBodySize = blankToNull(route.clientMaxBodySize) ?? STACK_DEFAULT_BODY_SIZE;
    if (!BODY_SIZE.test(clientMaxBodySize))
      return err(new ValidationError(`The upload limit for ${domain} must look like 100m or 5g`));
    routes.push({
      domain,
      service: service.name,
      containerPort: route.containerPort,
      hostPort,
      cloudflareCredentialId: blankToNull(route.cloudflareCredentialId),
      cloudflareZoneId: blankToNull(route.cloudflareZoneId),
      proxied: typeof route.proxied === 'boolean' ? route.proxied : null,
      https: route.https,
      clientMaxBodySize: clientMaxBodySize.toLowerCase(),
    });
  }

  const certificateEmail = blankToNull(input.certificateEmail);
  if (routes.some((route) => route.https) && (!certificateEmail || !EMAIL.test(certificateEmail)))
    return err(new ValidationError('Enter an email for the HTTPS certificates'));
  return ok({
    targetId,
    name,
    composeYaml: input.composeYaml,
    environment: input.environment,
    routes,
    certificateEmail,
  });
}

/** The lowest free local port from {@link STACK_FIRST_PORT}, skipping ports already taken. */
export function nextStackPort(taken: ReadonlySet<number>): number {
  let port = STACK_FIRST_PORT;
  while (taken.has(port)) port += 1;
  return port;
}

/**
 * The file CloudForge adds beside the user's Compose file, so that file stays
 * exactly as written. It publishes each route on 127.0.0.1 only, for Nginx to
 * reach, and labels every container. It holds no secret.
 */
export function renderStackOverride(options: {
  readonly name: string;
  readonly services: readonly string[];
  readonly routes: readonly Pick<StackRoute, 'domain' | 'service' | 'containerPort' | 'hostPort'>[];
}): string {
  const lines = [
    `# Managed by CloudForge for the stack ${options.name}. Do not edit.`,
    'services:',
  ];
  for (const service of options.services) {
    lines.push(
      `  ${JSON.stringify(service)}:`,
      '    labels:',
      '      com.cloudforge.managed: "true"',
      '      com.cloudforge.kind: "stack"',
      `      com.cloudforge.stack: ${JSON.stringify(options.name)}`,
    );
    const routes = options.routes.filter((route) => route.service === service);
    if (routes.length > 0) {
      lines.push('    ports:');
      for (const route of routes)
        lines.push(
          `      - "127.0.0.1:${String(route.hostPort)}:${String(route.containerPort)}" # ${route.domain}`,
        );
    }
  }
  lines.push('');
  return lines.join('\n');
}
