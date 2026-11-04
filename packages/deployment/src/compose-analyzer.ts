/**
 * Reads a Compose file before anything reaches a server, so the page can offer
 * its services and refuse what cannot work (a stack built from source, a file
 * that is not uploaded) instead of failing halfway through a deploy.
 *
 * Values from the `.env` are never returned; only its variable names are used.
 */
import type { ComposeAnalysis, ComposeAnalyzer, ComposeServiceInfo } from '@cloudforge/core';
import { parse } from 'yaml';

const SERVICE_NAME = /^[a-zA-Z0-9._-]+$/;
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

type YamlMap = Record<string, unknown>;

function asMap(value: unknown): YamlMap | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as YamlMap)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function hasVariable(value: string): boolean {
  return value.includes('$');
}

interface ParsedPort {
  readonly target: number | null;
  /** Published on the server's public interfaces, reachable from the internet. */
  readonly isPublic: boolean;
  readonly label: string;
}

function firstNumber(value: string): number | null {
  const match = /^(\d{1,5})(?:-\d{1,5})?$/.exec(value.trim());
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** Short form `[host:][published:]target[/protocol]`, or the long form as a map. */
function parsePort(entry: unknown): ParsedPort | null {
  const map = asMap(entry);
  if (map) {
    const target = scalar(map.target);
    const hostIp = typeof map.host_ip === 'string' ? map.host_ip : '';
    return {
      target: firstNumber(target),
      isPublic: !LOOPBACK.has(hostIp),
      label: scalar(map.published) || target,
    };
  }
  if (typeof entry !== 'string' && typeof entry !== 'number') return null;
  // A `${PORT:-80}` holds colons of its own, so it is set aside before splitting.
  const text = String(entry)
    .replace(/\$\{[^}]*\}/g, 'VARIABLE')
    .replace(/\/(?:tcp|udp)$/, '');
  const parts = text.split(':');
  const container = parts.pop() ?? '';
  const published = parts.pop();
  const host = parts.join(':');
  return {
    target: firstNumber(container),
    isPublic: !LOOPBACK.has(host),
    label: published ?? container,
  };
}

/** The file paths of a service's `env_file`, in any of its forms. */
function envFiles(value: unknown): { path: string; required: boolean }[] {
  const entries = typeof value === 'string' ? [value] : asList(value);
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [{ path: entry, required: true }];
    const map = asMap(entry);
    return map && typeof map.path === 'string'
      ? [{ path: map.path, required: map.required !== false }]
      : [];
  });
}

/** The host side of a volume entry, when it is a path rather than a named volume. */
function bindSource(entry: unknown): string | null {
  const map = asMap(entry);
  if (map) return map.type === 'bind' && typeof map.source === 'string' ? map.source : null;
  if (typeof entry !== 'string') return null;
  const source = entry.split(':')[0] ?? '';
  return /^(?:\.{0,2}\/|~)/.test(source) ? source : null;
}

/** Keys of a `.env` file, and the line numbers that are not `KEY=value`. */
function parseEnvironment(environment: string): { keys: Set<string>; malformed: number[] } {
  const keys = new Set<string>();
  const malformed: number[] = [];
  environment.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
    else malformed.push(index + 1);
  });
  return { keys, malformed };
}

/**
 * Variables the file needs that the `.env` does not set. Reads the parsed values
 * rather than the text, so a comment cannot produce a false alarm.
 */
function missingVariables(
  document: unknown,
  keys: ReadonlySet<string>,
): { required: string[]; unset: string[] } {
  const required = new Set<string>();
  const unset = new Set<string>();
  const text = JSON.stringify(document) ?? '';
  for (const match of text.matchAll(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?[^}]*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const name = match[1] ?? match[3];
    if (!name || keys.has(name)) continue;
    const operator = match[2];
    if (operator === ':?' || operator === '?') required.add(name);
    else if (!operator) unset.add(name);
  }
  return { required: [...required], unset: [...unset] };
}

/** `external: true`, the older `external: { name }`, and a `name:` beside it. */
function externalNames(section: unknown, kind: string, errors: string[]): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(asMap(section) ?? {})) {
    const definition = asMap(value);
    if (!definition?.external) continue;
    const legacy = asMap(definition.external);
    const named = legacy?.name ?? definition.name;
    const name = typeof named === 'string' ? named : key;
    if (hasVariable(name) || !DOCKER_NAME.test(name)) {
      errors.push(`The external ${kind} "${name}" needs a plain Docker name, without variables.`);
      continue;
    }
    names.push(name);
  }
  return names;
}

export function analyzeCompose(composeYaml: string, environment: string): ComposeAnalysis {
  const empty = { name: null, services: [], externalNetworks: [], externalVolumes: [] };
  if (composeYaml.trim() === '')
    return { ...empty, errors: ['Paste the Compose file.'], warnings: [] };

  let document: unknown;
  try {
    document = parse(composeYaml, { merge: true });
  } catch (cause) {
    // Only the first line: the rest quotes the file, which may hold a password.
    const message = cause instanceof Error ? (cause.message.split('\n')[0] ?? '') : '';
    return { ...empty, errors: [`The Compose file is not valid YAML. ${message}`], warnings: [] };
  }
  const root = asMap(document);
  const declared = asMap(root?.services);
  if (!root || !declared || Object.keys(declared).length === 0)
    return { ...empty, errors: ['The Compose file has no services.'], warnings: [] };

  const errors: string[] = [];
  const warnings: string[] = [];
  const { keys, malformed } = parseEnvironment(environment);
  if (malformed.length > 0)
    warnings.push(`The .env file has lines that are not KEY=value (line ${malformed.join(', ')}).`);
  if (root.include !== undefined)
    errors.push('The Compose file uses include:, but only this file and .env are uploaded.');

  let usesEnvFile = false;
  const services: ComposeServiceInfo[] = [];
  for (const [name, raw] of Object.entries(declared)) {
    const service = asMap(raw);
    if (!service) {
      errors.push(`Service "${name}" is empty.`);
      continue;
    }
    if (!SERVICE_NAME.test(name))
      errors.push(`Service "${name}" has a name Docker Compose does not accept.`);
    if (service.build !== undefined)
      errors.push(
        `Service "${name}" builds from source (build:). Only this file and .env are uploaded, so push the image to a registry and use image: instead.`,
      );
    else if (typeof service.image !== 'string' || service.image.trim() === '')
      errors.push(`Service "${name}" has no image.`);
    if (asMap(service.extends)?.file !== undefined)
      errors.push(`Service "${name}" extends another file, but only this file is uploaded.`);

    for (const { path, required } of envFiles(service.env_file)) {
      if (path.replace(/^\.\//, '') === '.env') usesEnvFile = true;
      else if (required)
        errors.push(
          `Service "${name}" reads the env file "${path}". Only .env is uploaded, so move those variables there.`,
        );
    }

    const hostNetwork = service.network_mode === 'host';
    if (hostNetwork)
      warnings.push(
        `Service "${name}" uses the host network: its ports are open on the server directly, and no domain can be mapped to it.`,
      );
    if (service.privileged === true)
      warnings.push(`Service "${name}" runs privileged, with full control of the server.`);

    const ports = new Set<number>();
    for (const entry of asList(service.ports)) {
      const port = parsePort(entry);
      if (!port) continue;
      if (port.target !== null) ports.add(port.target);
      if (port.isPublic)
        warnings.push(
          `Service "${name}" publishes port ${port.label} on all interfaces, so anyone on the internet can reach it directly: Docker bypasses the server's firewall. Remove it, or bind it to 127.0.0.1, if a domain is enough.`,
        );
    }
    for (const entry of asList(service.expose)) {
      const port = firstNumber(String(entry).replace(/\/(?:tcp|udp)$/, ''));
      if (port !== null) ports.add(port);
    }

    for (const entry of asList(service.volumes)) {
      const source = bindSource(entry);
      if (!source) continue;
      if (source === '/var/run/docker.sock' || source === '/run/docker.sock')
        warnings.push(
          `Service "${name}" mounts the Docker socket, which gives it full control of the server.`,
        );
      else if (source.startsWith('.'))
        warnings.push(
          `Service "${name}" mounts ${source}. Only this file and .env are uploaded, so it starts empty on the server.`,
        );
    }

    const containerName =
      typeof service.container_name === 'string' ? service.container_name.trim() : null;
    if (containerName && !hasVariable(containerName) && !DOCKER_NAME.test(containerName))
      errors.push(`Service "${name}" has a container_name Docker does not accept.`);
    services.push({
      name,
      image: typeof service.image === 'string' ? service.image.trim() : null,
      containerName: containerName && !hasVariable(containerName) ? containerName : null,
      ports: [...ports].sort((a, b) => a - b),
      hostNetwork,
    });
  }

  if (usesEnvFile && keys.size === 0)
    warnings.push('The Compose file reads .env, but the .env file is empty.');
  const { required, unset } = missingVariables(document, keys);
  for (const name of required) errors.push(`The Compose file requires ${name}: add it to .env.`);
  if (unset.length > 0)
    warnings.push(
      `The Compose file uses ${unset.join(', ')}, not set in .env. They will be empty.`,
    );

  for (const section of [root.configs, root.secrets]) {
    for (const [key, value] of Object.entries(asMap(section) ?? {})) {
      if (asMap(value)?.file !== undefined)
        warnings.push(`"${key}" reads a file, but only the Compose file and .env are uploaded.`);
    }
  }

  return {
    name: typeof root.name === 'string' && !hasVariable(root.name) ? root.name : null,
    services,
    externalNetworks: externalNames(root.networks, 'network', errors),
    externalVolumes: externalNames(root.volumes, 'volume', errors),
    errors,
    warnings,
  };
}

export class YamlComposeAnalyzer implements ComposeAnalyzer {
  analyze(composeYaml: string, environment: string): ComposeAnalysis {
    return analyzeCompose(composeYaml, environment);
  }
}
