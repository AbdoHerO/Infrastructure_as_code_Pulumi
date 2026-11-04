/**
 * The shell that runs a Docker Compose stack on a server.
 *
 * Pure string builders, so the shell is tested without a VPS. Every script is
 * POSIX `sh` and runs as root through `privilegedScript`.
 *
 * Safety rules:
 * - a stack lives in `/opt/cloudforge/stacks/<name>`; a directory there without
 *   the CloudForge marker is never changed or deleted;
 * - a Compose project, a container name or a port that belongs to something else
 *   stops the deploy before anything changes;
 * - the Compose file and `.env` may hold passwords, so they never appear in a
 *   script or on a command line: they arrive as owner-only files over SFTP, and
 *   the uploads are deleted on exit;
 * - a new file is validated in a staging folder first, so a broken edit leaves
 *   the running stack and its files as they were;
 * - external networks and volumes are created when missing and never deleted:
 *   other stacks may use them.
 *
 * Machine-readable lines start with `@@` so the adapter can keep them out of
 * the log shown to the user:
 *   @@CONTAINER|service|name|state|health|image
 *   @@PORT|8400|open
 *   @@LISTEN|8400
 *   @@DOCKER|0.0.0.0:3000->3000/tcp, 127.0.0.1:8091->80/tcp
 */
import {
  STACK_NAME_PATTERN,
  type StackContainerState,
  type StackPortState,
} from '@cloudforge/core';
import { base64, quote } from './ssh-transport.js';

export const STACK_ROOT = '/opt/cloudforge/stacks';
export const STACK_MARKER = '.cloudforge-stack';

const OVERRIDE_FILE = 'compose.cloudforge.yaml';
/** Up to 90 seconds for an application to start answering on its port. */
const PORT_ATTEMPTS = 45;

function assertProject(project: string): void {
  // Validated above; checked again because it is interpolated into shell.
  if (!STACK_NAME_PATTERN.test(project)) throw new Error(`Invalid stack name ${project}`);
}

function assertPorts(ports: readonly number[]): void {
  for (const port of ports)
    if (!Number.isInteger(port) || port < 1024 || port > 65_535)
      throw new Error(`Invalid stack port ${String(port)}`);
}

export function stackDirectory(project: string): string {
  assertProject(project);
  return `${STACK_ROOT}/${project}`;
}

function preamble(project: string): string[] {
  const directory = stackDirectory(project);
  return [
    '#!/bin/sh',
    'set -eu',
    `PROJECT=${quote(project)}`,
    `DIR=${quote(directory)}`,
    'say() { printf \'==> %s\\n\' "$1"; }',
    'fail() { printf \'%s\\n\' "$1" >&2; exit 1; }',
    `compose() { docker compose -p "$PROJECT" -f compose.yaml -f ${OVERRIDE_FILE} "$@"; }`,
    'command -v docker >/dev/null 2>&1 || fail "Docker is not installed on this server. Install it from VPS Runtime first."',
    'docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not available on this server."',
    `if [ -e "$DIR" ] && [ ! -f "$DIR/${STACK_MARKER}" ]; then fail "$DIR exists but was not created by CloudForge; it was not changed."; fi`,
  ];
}

/** Whether something answers on a local port: any HTTP response counts as open. */
const PORT_STATE = [
  'port_state() {',
  '  command -v curl >/dev/null 2>&1 || { echo unknown; return 0; }',
  '  attempt=0',
  '  while [ "$attempt" -lt "$2" ]; do',
  '    if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$1/"; then echo open; return 0; fi',
  '    attempt=$((attempt + 1))',
  '    [ "$attempt" -lt "$2" ] && sleep 2',
  '  done',
  '  echo closed',
  '}',
];

function statusLines(hostPorts: readonly number[], attempts: number): string[] {
  return [
    "compose ps -a --format '{{.Service}}|{{.Name}}|{{.State}}|{{.Health}}|{{.Image}}' | sed 's/^/@@CONTAINER|/'",
    ...hostPorts.map(
      (port) =>
        `printf '@@PORT|%s|%s\\n' ${String(port)} "$(port_state ${String(port)} ${String(attempts)})"`,
    ),
  ];
}

export interface StackDeployScript {
  readonly project: string;
  readonly overrideYaml: string;
  readonly externalNetworks: readonly string[];
  readonly externalVolumes: readonly string[];
  readonly containerNames: readonly string[];
  readonly hostPorts: readonly number[];
  /** Uploaded owner-only files: the user's Compose file and `.env`. */
  readonly composeFile: string;
  readonly environmentFile: string;
}

export function deployStackScript(options: StackDeployScript): string {
  assertPorts(options.hostPorts);
  for (const file of [options.composeFile, options.environmentFile])
    if (!/^\/tmp\/cloudforge-stack-[a-f0-9-]{36}\.(yaml|env)$/.test(file))
      throw new Error(`Unexpected upload path ${file}`);
  return [
    ...preamble(options.project),
    ...PORT_STATE,
    `COMPOSE_UPLOAD=${quote(options.composeFile)}`,
    `ENV_UPLOAD=${quote(options.environmentFile)}`,
    'STAGING="$DIR/.staging"',
    'trap \'rm -f "$COMPOSE_UPLOAD" "$ENV_UPLOAD"; rm -rf "$STAGING"\' EXIT',
    '[ -s "$COMPOSE_UPLOAD" ] && [ -e "$ENV_UPLOAD" ] || fail "The stack files did not reach the server."',
    // Everything that belongs to something else stops here, before any change.
    `if [ ! -f "$DIR/${STACK_MARKER}" ] && [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | head -n 1)" ]; then`,
    '  fail "A Docker stack named $PROJECT already runs on this server, not deployed by CloudForge. Choose another name."',
    'fi',
    "listening=$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || true) | awk '{print $4}')",
    ...options.hostPorts.flatMap((port) => [
      `if printf '%s\\n' "$listening" | grep -Eq '[:.]${String(port)}$'; then`,
      `  owner=$(docker ps --filter "publish=${String(port)}" --format '{{.Label "com.docker.compose.project"}}' | head -n 1)`,
      `  [ "$owner" = "$PROJECT" ] || fail "Port ${String(port)} is already used on this server. Remove this stack and deploy it again with another port."`,
      'fi',
    ]),
    ...options.containerNames.flatMap((name) => [
      // Existence first: with --format, inspect prints a blank line for a missing container.
      `if docker container inspect ${quote(name)} >/dev/null 2>&1; then`,
      `  owner=$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' ${quote(name)})`,
      `  [ "$owner" = "$PROJECT" ] || fail ${quote(`A container named ${name} already exists on this server and is not part of this stack. Remove it or change container_name.`)}`,
      'fi',
    ]),
    "say 'Checking the Compose file'",
    'install -d -m 700 "$DIR" "$STAGING"',
    `: > "$DIR/${STACK_MARKER}"`,
    'install -m 600 "$COMPOSE_UPLOAD" "$STAGING/compose.yaml"',
    'install -m 600 "$ENV_UPLOAD" "$STAGING/.env"',
    `printf '%s' '${base64(options.overrideYaml)}' | base64 -d > "$STAGING/${OVERRIDE_FILE}"`,
    `chmod 600 "$STAGING/${OVERRIDE_FILE}"`,
    '(cd "$STAGING" && compose config -q)',
    `mv -f "$STAGING/compose.yaml" "$STAGING/.env" "$STAGING/${OVERRIDE_FILE}" "$DIR/"`,
    'cd "$DIR"',
    ...options.externalNetworks.flatMap((name) => [
      `if ! docker network inspect ${quote(name)} >/dev/null 2>&1; then`,
      `  say ${quote(`Creating the Docker network ${name}`)}`,
      `  docker network create ${quote(name)} >/dev/null`,
      'fi',
    ]),
    ...options.externalVolumes.flatMap((name) => [
      `if ! docker volume inspect ${quote(name)} >/dev/null 2>&1; then`,
      `  say ${quote(`Creating the Docker volume ${name}`)}`,
      `  docker volume create ${quote(name)} >/dev/null`,
      'fi',
    ]),
    "say 'Downloading the images'",
    // An image built on this server has no registry to pull from; `up` reports a real absence.
    'compose pull --quiet --ignore-pull-failures',
    "say 'Starting the stack'",
    'compose up -d --remove-orphans',
    ...(options.hostPorts.length > 0 ? ["say 'Waiting for the application to answer'"] : []),
    ...statusLines(options.hostPorts, PORT_ATTEMPTS),
    '',
  ].join('\n');
}

export function stackStatusScript(project: string, hostPorts: readonly number[]): string {
  assertPorts(hostPorts);
  return [
    ...preamble(project),
    ...PORT_STATE,
    '[ -f "$DIR/compose.yaml" ] || exit 0',
    'cd "$DIR"',
    ...statusLines(hostPorts, 1),
    '',
  ].join('\n');
}

export function removeStackScript(project: string, deleteData: boolean): string {
  return [
    ...preamble(project),
    'if [ -f "$DIR/compose.yaml" ]; then',
    '  cd "$DIR"',
    `  say ${quote(deleteData ? 'Removing the containers and the volumes of this stack' : 'Removing the containers (the volumes and files are kept)')}`,
    `  compose down --remove-orphans${deleteData ? ' --volumes' : ''}`,
    '  cd /',
    'fi',
    ...(deleteData
      ? [
          'if [ -d "$DIR" ]; then rm -rf "$DIR"; fi',
          "say 'The stack was deleted. External networks and volumes were kept, because other stacks may use them'",
        ]
      : ['say "Kept the volumes and $DIR, so the stack can be deployed again"']),
    '',
  ].join('\n');
}

/** Ports in use: what listens on the server, and what Docker publishes. */
export function usedPortsScript(): string {
  return [
    '#!/bin/sh',
    "(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || true) | awk '{print $4}' | sed 's/.*://; s/^/@@LISTEN|/'",
    "if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Ports}}' 2>/dev/null | sed 's/^/@@DOCKER|/'; fi",
    'exit 0',
    '',
  ].join('\n');
}

export function parseUsedPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('@@LISTEN|')) {
      const port = Number(line.slice('@@LISTEN|'.length).trim());
      if (Number.isInteger(port) && port > 0) ports.add(port);
    } else if (line.startsWith('@@DOCKER|')) {
      for (const match of line.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
        const first = Number(match[1]);
        const last = match[2] ? Number(match[2]) : first;
        for (let port = first; port <= last && port - first < 1024; port += 1) ports.add(port);
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export interface ParsedStackStatus {
  readonly containers: StackContainerState[];
  readonly ports: StackPortState[];
}

export function parseStackStatus(output: string): ParsedStackStatus {
  const containers: StackContainerState[] = [];
  const ports: StackPortState[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('@@')) continue;
    const [kind, ...fields] = line.slice(2).split('|');
    if (kind === 'CONTAINER' && fields.length >= 5) {
      const [service = '', name = '', state = '', health = '', ...image] = fields;
      containers.push({ service, name, state, health, image: image.join('|') });
    } else if (kind === 'PORT') {
      const port = Number(fields[0]);
      const state = fields[1]?.trim();
      if (Number.isInteger(port) && (state === 'open' || state === 'closed' || state === 'unknown'))
        ports.push({ port, state });
    }
  }
  return { containers, ports };
}
