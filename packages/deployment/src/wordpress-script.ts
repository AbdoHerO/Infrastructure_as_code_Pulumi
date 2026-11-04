/**
 * The shell that runs one WordPress site as a Docker Compose project.
 *
 * Pure string builders, so the shell is tested without a VPS. Every script is
 * POSIX `sh` and runs as root through `privilegedScript`.
 *
 * Safety rules:
 * - a site lives in `/opt/cloudforge/wordpress/<project>`; a directory there
 *   without the CloudForge marker file is never changed or deleted;
 * - passwords never appear in a script or on a command line: they arrive as
 *   owner-only files uploaded over SFTP, are moved into place (`.env`, mode 600)
 *   or fed to WP-CLI on stdin, and the uploads are deleted on exit;
 * - an existing `.env` is kept, because the database volume was initialised
 *   with those passwords;
 * - WordPress binds 127.0.0.1 only; a port that something else already listens
 *   on stops the deploy before anything starts.
 *
 * Machine-readable lines start with `@@` so the adapter can keep them out of
 * the log shown to the user:
 *   @@CONTAINER|service|name|state|health|image
 *   @@VERSION|6.9.1
 *   @@INSTALLED|1
 */
import { WORDPRESS_PROJECT_PATTERN, type WordPressContainerState } from '@cloudforge/core';
import { base64, quote } from './ssh-transport.js';

export const WORDPRESS_ROOT = '/opt/cloudforge/wordpress';
export const WORDPRESS_MARKER = '.cloudforge-wordpress';

function assertProject(project: string): void {
  // Derived and validated above; checked again because it is interpolated into shell.
  if (!WORDPRESS_PROJECT_PATTERN.test(project))
    throw new Error(`Invalid WordPress project name ${project}`);
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error(`Invalid WordPress port ${port}`);
}

export function wordpressDirectory(project: string): string {
  assertProject(project);
  return `${WORDPRESS_ROOT}/${project}`;
}

function preamble(project: string): string[] {
  const directory = wordpressDirectory(project);
  return [
    '#!/bin/sh',
    'set -eu',
    `PROJECT=${quote(project)}`,
    `DIR=${quote(directory)}`,
    'say() { printf \'==> %s\\n\' "$1"; }',
    'fail() { printf \'%s\\n\' "$1" >&2; exit 1; }',
    'compose() { docker compose -p "$PROJECT" "$@"; }',
    'command -v docker >/dev/null 2>&1 || fail "Docker is not installed on this server. Install it from VPS Runtime first."',
    'docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not available on this server."',
    `if [ -e "$DIR" ] && [ ! -f "$DIR/${WORDPRESS_MARKER}" ]; then fail "$DIR exists but was not created by CloudForge; it was not changed."; fi`,
  ];
}

/** Wait until the WordPress entrypoint has written wp-config.php (up to 3 minutes). */
const WAIT_FOR_WORDPRESS = [
  "say 'Waiting for WordPress to be ready'",
  'ready=0',
  'for _ in $(seq 1 90); do',
  '  if compose exec -T wordpress test -f /var/www/html/wp-config.php >/dev/null 2>&1; then ready=1; break; fi',
  '  sleep 2',
  'done',
  'if [ "$ready" != 1 ]; then',
  '  compose logs --tail 40 >&2 || true',
  '  fail "WordPress did not start within 3 minutes. The container logs are above."',
  'fi',
];

const STATUS = [
  "compose ps -a --format '{{.Service}}|{{.Name}}|{{.State}}|{{.Health}}|{{.Image}}' | sed 's/^/@@CONTAINER|/'",
  `version=$(compose exec -T wordpress php -r 'include "/var/www/html/wp-includes/version.php"; echo $wp_version;' 2>/dev/null || true)`,
  'printf \'@@VERSION|%s\\n\' "$version"',
  "if compose run --rm -T cli wp core is-installed >/dev/null 2>&1; then echo '@@INSTALLED|1'; else echo '@@INSTALLED|0'; fi",
];

const ADMIN_USER = /^[A-Za-z0-9_.@-]{3,60}$/;

/** PHP for `wp eval`: read the password from stdin and set it on the admin account. */
export function setAdminPasswordPhp(adminUser: string): string {
  // Validated above; checked again because it is interpolated into PHP.
  if (!ADMIN_USER.test(adminUser)) throw new Error(`Invalid admin user name ${adminUser}`);
  return [
    `$user = get_user_by('login', '${adminUser}');`,
    'if (!$user) { fwrite(STDERR, "The admin account was not found\\n"); exit(1); }',
    '$password = rtrim(stream_get_contents(STDIN), "\\r\\n");',
    'if ($password === "") { fwrite(STDERR, "The admin password is empty\\n"); exit(1); }',
    'wp_set_password($password, $user->ID);',
    'echo "Admin password set\\n";',
  ].join(' ');
}

export interface WordPressDeployScript {
  readonly project: string;
  readonly composeYaml: string;
  readonly phpIni: string;
  readonly hostPort: number;
  readonly siteUrl: string;
  readonly siteTitle: string;
  readonly adminUser: string;
  readonly adminEmail: string;
  /** Uploaded owner-only files: database passwords (`.env`) and the admin password. */
  readonly environmentFile: string;
  readonly adminPasswordFile: string;
}

export function deployWordPressScript(options: WordPressDeployScript): string {
  assertPort(options.hostPort);
  for (const file of [options.environmentFile, options.adminPasswordFile])
    if (!/^\/tmp\/cloudforge-wp-[a-f0-9-]{36}\.(env|pw)$/.test(file))
      throw new Error(`Unexpected upload path ${file}`);
  return [
    ...preamble(options.project),
    `PORT=${String(options.hostPort)}`,
    `ENV_FILE=${quote(options.environmentFile)}`,
    `PASSWORD_FILE=${quote(options.adminPasswordFile)}`,
    'trap \'rm -f "$ENV_FILE" "$PASSWORD_FILE"\' EXIT',
    '[ -s "$ENV_FILE" ] && [ -s "$PASSWORD_FILE" ] || fail "The site passwords did not reach the server."',
    // Something other than this site already listening on the port would make Nginx
    // publish the wrong service; stop before starting anything.
    'listening=$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || true) | awk \'{print $4}\' | grep -E "[:.]$PORT$" || true)',
    'if [ -n "$listening" ]; then',
    '  owner=$(docker ps --filter "publish=$PORT" --format \'{{.Label "com.docker.compose.project"}}\' | head -n 1)',
    '  [ "$owner" = "$PROJECT" ] || fail "Port $PORT is already used on this server. Choose another port."',
    'fi',
    "say 'Writing the site configuration'",
    'install -d -m 700 "$DIR"',
    `: > "$DIR/${WORDPRESS_MARKER}"`,
    `printf '%s' '${base64(options.composeYaml)}' | base64 -d > "$DIR/compose.yaml"`,
    `printf '%s' '${base64(options.phpIni)}' | base64 -d > "$DIR/php.ini"`,
    'chmod 600 "$DIR/compose.yaml"',
    'chmod 644 "$DIR/php.ini"',
    'if [ -s "$DIR/.env" ]; then',
    "  say 'Keeping the existing database passwords'",
    'else',
    '  install -m 600 "$ENV_FILE" "$DIR/.env"',
    'fi',
    'cd "$DIR"',
    "say 'Downloading the latest WordPress, MariaDB and WP-CLI images (a few minutes the first time)'",
    'compose --profile tools pull --quiet',
    "say 'Starting the database and WordPress'",
    'compose up -d --remove-orphans',
    ...WAIT_FOR_WORDPRESS,
    'if compose run --rm -T cli wp core is-installed >/dev/null 2>&1; then',
    "  say 'WordPress is already installed; its content is kept'",
    'else',
    "  say 'Installing WordPress'",
    // WP-CLI's --prompt echoes the value it reads, so the real password never goes
    // through it: install with a random throwaway one, then set the real one from
    // stdin inside PHP, where it is neither an argument nor printed.
    '  bootstrap=$(od -An -N24 -tx1 /dev/urandom | tr -d " \\n")',
    '  compose run --rm -T cli wp core install ' +
      [
        `--url=${quote(options.siteUrl)}`,
        `--title=${quote(options.siteTitle)}`,
        `--admin_user=${quote(options.adminUser)}`,
        `--admin_email=${quote(options.adminEmail)}`,
        '--admin_password="$bootstrap"',
        '--skip-email',
      ].join(' '),
    // Only at install: a password changed later inside WordPress is never overwritten.
    "  say 'Setting the admin password'",
    `  compose run --rm -T cli wp eval ${quote(setAdminPasswordPhp(options.adminUser))} < "$PASSWORD_FILE"`,
    'fi',
    ...STATUS,
    '',
  ].join('\n');
}

/** Latest images, then WordPress core and its database schema; content is kept. */
export function updateWordPressScript(project: string): string {
  return [
    ...preamble(project),
    '[ -f "$DIR/compose.yaml" ] || fail "This site is not deployed on the server."',
    'cd "$DIR"',
    "say 'Downloading the latest images'",
    'compose --profile tools pull --quiet',
    "say 'Restarting with the new images'",
    'compose up -d --remove-orphans',
    ...WAIT_FOR_WORDPRESS,
    "say 'Updating WordPress core'",
    'compose run --rm -T cli wp core update',
    'compose run --rm -T cli wp core update-db',
    ...STATUS,
    '',
  ].join('\n');
}

export function wordpressStatusScript(project: string): string {
  return [
    ...preamble(project),
    '[ -f "$DIR/compose.yaml" ] || { echo "@@INSTALLED|0"; exit 0; }',
    'cd "$DIR"',
    ...STATUS,
    '',
  ].join('\n');
}

export function removeWordPressScript(project: string, deleteData: boolean): string {
  return [
    ...preamble(project),
    'if [ -f "$DIR/compose.yaml" ]; then',
    '  cd "$DIR"',
    `  say ${quote(deleteData ? 'Removing the containers, the database and the files' : 'Removing the containers (the database and files are kept)')}`,
    `  compose --profile tools down --remove-orphans${deleteData ? ' --volumes' : ''}`,
    '  cd /',
    'else',
    "  say 'No site files on the server; removing any leftover containers'",
    '  docker compose -p "$PROJECT" down --remove-orphans >/dev/null 2>&1 || true',
    'fi',
    ...(deleteData
      ? ['if [ -d "$DIR" ]; then rm -rf "$DIR"; fi', "say 'All site data was deleted'"]
      : ['say "Kept the volumes and $DIR, so the site can be deployed again with its content"']),
    '',
  ].join('\n');
}

export interface ParsedWordPressStatus {
  readonly containers: WordPressContainerState[];
  readonly wordpressVersion: string | null;
  readonly installed: boolean;
}

export function parseWordPressStatus(output: string): ParsedWordPressStatus {
  const containers: WordPressContainerState[] = [];
  let wordpressVersion: string | null = null;
  let installed = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('@@')) continue;
    const [kind, ...fields] = line.slice(2).split('|');
    if (kind === 'CONTAINER' && fields.length >= 5) {
      const [service = '', name = '', state = '', health = '', ...image] = fields;
      containers.push({ service, name, state, health, image: image.join('|') });
    } else if (kind === 'VERSION') {
      const version = (fields[0] ?? '').trim();
      wordpressVersion = /^\d+\.\d+(?:\.\d+)?[\w.-]*$/.test(version) ? version : null;
    } else if (kind === 'INSTALLED') {
      installed = fields[0]?.trim() === '1';
    }
  }
  return { containers, wordpressVersion, installed };
}
