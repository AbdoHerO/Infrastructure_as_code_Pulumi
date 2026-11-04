import { err, ok, ValidationError, type Result } from '@cloudforge/shared';

/** Official images, latest stable: WordPress (PHP + Apache), MariaDB LTS, WP-CLI. */
export const WORDPRESS_IMAGE = 'wordpress:latest';
export const WORDPRESS_DATABASE_IMAGE = 'mariadb:lts';
export const WORDPRESS_CLI_IMAGE = 'wordpress:cli';

/** First host port offered for a new site; each site binds one port on 127.0.0.1. */
export const WORDPRESS_FIRST_PORT = 8300;

export interface WordPressSiteInput {
  readonly targetId: string;
  readonly domain: string;
  readonly siteTitle: string;
  readonly adminUser: string;
  readonly adminEmail: string;
  /** Generated when empty. */
  readonly adminPassword?: string;
  /** Chosen automatically when absent. */
  readonly hostPort?: number | null;
  readonly cloudflareCredentialId?: string | null;
  readonly cloudflareZoneId?: string | null;
  readonly https: boolean;
  readonly certificateEmail?: string | null;
}

export interface ValidWordPressSiteInput {
  readonly targetId: string;
  readonly domain: string;
  readonly siteTitle: string;
  readonly adminUser: string;
  readonly adminEmail: string;
  readonly adminPassword: string | null;
  readonly hostPort: number | null;
  readonly cloudflareCredentialId: string | null;
  readonly cloudflareZoneId: string | null;
  readonly https: boolean;
  readonly certificateEmail: string | null;
}

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@<>"'`\\]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// WordPress allows letters, digits, space, _ . - @ in user names; CloudForge drops the space.
const ADMIN_USER = /^[A-Za-z0-9_.@-]{3,60}$/;
const RESERVED_USERS = new Set(['admin', 'administrator', 'root', 'wordpress', 'test']);

export function validateWordPressSite(
  input: WordPressSiteInput,
): Result<ValidWordPressSiteInput, ValidationError> {
  const targetId = input.targetId.trim();
  if (!targetId) return err(new ValidationError('Choose the server for this site'));
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN.test(domain))
    return err(new ValidationError('Enter a domain name such as blog.example.com'));
  const siteTitle = input.siteTitle.trim();
  if (!siteTitle || siteTitle.length > 100 || hasControlCharacter(siteTitle))
    return err(new ValidationError('Enter a site title of 1 to 100 characters'));
  const adminUser = input.adminUser.trim();
  if (!ADMIN_USER.test(adminUser))
    return err(
      new ValidationError(
        'The admin user name needs 3 to 60 letters, digits or _ . - @ (no spaces)',
      ),
    );
  if (RESERVED_USERS.has(adminUser.toLowerCase()))
    return err(
      new ValidationError(
        `"${adminUser}" is the first name attackers try. Choose a less obvious admin user name`,
      ),
    );
  const adminEmail = input.adminEmail.trim();
  if (!EMAIL.test(adminEmail)) return err(new ValidationError('Enter a valid admin email'));
  const password = input.adminPassword ?? '';
  if (password !== '' && (password.length < 12 || password.length > 200))
    return err(new ValidationError('The admin password needs at least 12 characters'));
  if (/[\r\n]/.test(password))
    return err(new ValidationError('The admin password cannot contain line breaks'));
  const hostPort = input.hostPort ?? null;
  if (hostPort !== null && (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65_535))
    return err(new ValidationError('The port must be a whole number from 1024 to 65535'));
  const certificateEmail = (input.certificateEmail ?? '').trim() || adminEmail;
  if (input.https && !EMAIL.test(certificateEmail))
    return err(new ValidationError('Enter a valid email for the HTTPS certificate'));
  return ok({
    targetId,
    domain,
    siteTitle,
    adminUser,
    adminEmail,
    adminPassword: password === '' ? null : password,
    hostPort,
    cloudflareCredentialId: blankToNull(input.cloudflareCredentialId),
    cloudflareZoneId: blankToNull(input.cloudflareZoneId),
    https: input.https,
    certificateEmail: input.https ? certificateEmail : null,
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** `blog.example.com` → `cloudforge-wp-blog-example-com` (Compose project, directory, containers). */
export function wordpressProject(domain: string): string {
  const slug = domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `cloudforge-wp-${slug}`;
}

export const WORDPRESS_PROJECT_PATTERN = /^cloudforge-wp-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The lowest free port from {@link WORDPRESS_FIRST_PORT}, skipping ports already taken. */
export function nextWordPressPort(taken: Iterable<number>): number {
  const used = new Set(taken);
  let port = WORDPRESS_FIRST_PORT;
  while (used.has(port)) port += 1;
  return port;
}

const SECRET_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * A random secret from an alphabet that needs no quoting in an env file or a
 * shell, using the platform CSPRNG (Node and the renderer both provide it).
 */
export function generateWordPressSecret(length = 32): string {
  const limit = 256 - (256 % SECRET_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < limit && out.length < length)
        out += SECRET_ALPHABET[byte % SECRET_ALPHABET.length];
    }
  }
  return out;
}

export function wordpressSiteUrl(domain: string, https: boolean): string {
  return `${https ? 'https' : 'http'}://${domain}`;
}

/**
 * PHP that runs inside wp-config.php. Behind Nginx (and Cloudflare) the
 * container only sees HTTP, so it trusts the proxy's scheme headers; the site
 * URL is pinned so WordPress never redirects to the internal port.
 */
function configExtra(siteUrl: string): string[] {
  return [
    "if ((isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strpos($_SERVER['HTTP_X_FORWARDED_PROTO'], 'https') !== false)",
    "    || (isset($_SERVER['HTTP_CF_VISITOR']) && strpos($_SERVER['HTTP_CF_VISITOR'], 'https') !== false)) {",
    "  $_SERVER['HTTPS'] = 'on';",
    '}',
    `define('WP_HOME', '${siteUrl}');`,
    `define('WP_SITEURL', '${siteUrl}');`,
    "define('FS_METHOD', 'direct');",
  ];
}

/**
 * Docker Compose file for one site. It holds no secret: passwords come from the
 * `.env` file beside it (mode 600), which Compose reads for `${...}`.
 * WordPress listens only on 127.0.0.1; Nginx publishes it on the domain.
 */
export function renderWordPressCompose(options: {
  readonly project: string;
  readonly domain: string;
  readonly hostPort: number;
  readonly siteUrl: string;
}): string {
  const { project, domain, hostPort, siteUrl } = options;
  // Compose interpolates `$name`; a literal PHP `$` must be written `$$`.
  const php = configExtra(siteUrl).map((line) => `        ${line.replace(/\$/g, '$$$$')}`);
  const labels = (role: string): string[] => [
    '    labels:',
    '      com.cloudforge.managed: "true"',
    '      com.cloudforge.kind: "wordpress"',
    `      com.cloudforge.domain: "${domain}"`,
    `      com.cloudforge.role: "${role}"`,
  ];
  const databaseEnvironment = [
    '      WORDPRESS_DB_HOST: db',
    '      WORDPRESS_DB_NAME: wordpress',
    '      WORDPRESS_DB_USER: wordpress',
    '      WORDPRESS_DB_PASSWORD: ${DB_PASSWORD}',
  ];
  return [
    `# Managed by CloudForge: WordPress for ${domain}. Edit from CloudForge, not by hand.`,
    `name: ${project}`,
    'services:',
    '  db:',
    `    image: ${WORDPRESS_DATABASE_IMAGE}`,
    `    container_name: ${project}-db`,
    '    restart: unless-stopped',
    '    environment:',
    '      MARIADB_DATABASE: wordpress',
    '      MARIADB_USER: wordpress',
    '      MARIADB_PASSWORD: ${DB_PASSWORD}',
    '      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}',
    '      MARIADB_AUTO_UPGRADE: "1"',
    '    volumes:',
    '      - db-data:/var/lib/mysql',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 10s',
    '      timeout: 5s',
    '      retries: 30',
    '      start_period: 30s',
    '    networks:',
    '      - internal',
    ...labels('database'),
    '  wordpress:',
    `    image: ${WORDPRESS_IMAGE}`,
    `    container_name: ${project}-wordpress`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    ports:',
    `      - "127.0.0.1:${hostPort}:80"`,
    '    environment:',
    ...databaseEnvironment,
    '      WORDPRESS_CONFIG_EXTRA: |',
    ...php,
    '    volumes:',
    '      - wp-data:/var/www/html',
    '      - ./php.ini:/usr/local/etc/php/conf.d/cloudforge.ini:ro',
    '    networks:',
    '      - internal',
    ...labels('web'),
    '  cli:',
    `    image: ${WORDPRESS_CLI_IMAGE}`,
    '    profiles: ["tools"]',
    // www-data is uid 33 in the WordPress image but 82 in the Alpine CLI image.
    '    user: "33:33"',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    environment:',
    ...databaseEnvironment,
    '      HOME: /tmp',
    '      WP_CLI_CACHE_DIR: /tmp/wp-cli-cache',
    '    volumes:',
    '      - wp-data:/var/www/html',
    '    networks:',
    '      - internal',
    ...labels('cli'),
    'volumes:',
    '  db-data:',
    '  wp-data:',
    'networks:',
    '  internal:',
    '',
  ].join('\n');
}

/** PHP limits that fit a real site: theme and plugin uploads, imports, page builders. */
export function renderWordPressPhpIni(): string {
  return [
    '; Managed by CloudForge',
    'upload_max_filesize = 64M',
    'post_max_size = 64M',
    'memory_limit = 256M',
    'max_execution_time = 300',
    'max_input_vars = 3000',
    '',
  ].join('\n');
}
