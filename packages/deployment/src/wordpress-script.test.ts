import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderWordPressCompose, renderWordPressPhpIni } from '@cloudforge/core';
import {
  deployWordPressScript,
  parseWordPressStatus,
  removeWordPressScript,
  updateWordPressScript,
  wordpressDirectory,
  wordpressStatusScript,
} from './wordpress-script.js';
import { lineEvents } from './line-events.js';
import { parsesAsShell } from './shell-syntax.test-helper.js';

const PROJECT = 'cloudforge-wp-blog-example-com';
const UPLOAD = '0f8fad5b-d9cb-469f-a165-70867728950e';

const compose = renderWordPressCompose({
  project: PROJECT,
  domain: 'blog.example.com',
  hostPort: 8300,
  siteUrl: 'https://blog.example.com',
});

function deploy(overrides: Partial<Parameters<typeof deployWordPressScript>[0]> = {}): string {
  return deployWordPressScript({
    project: PROJECT,
    composeYaml: compose,
    phpIni: renderWordPressPhpIni(),
    hostPort: 8300,
    siteUrl: 'https://blog.example.com',
    siteTitle: 'Alex\'s "Bakery" $(reboot)',
    adminUser: 'alex',
    adminEmail: 'alex@example.com',
    environmentFile: `/tmp/cloudforge-wp-${UPLOAD}.env`,
    adminPasswordFile: `/tmp/cloudforge-wp-${UPLOAD}.pw`,
    ...overrides,
  });
}

describe('WordPress compose file', () => {
  const document = parse(compose) as {
    name: string;
    services: Record<string, Record<string, unknown>>;
    volumes: Record<string, unknown>;
  };

  it('is valid YAML with a database, WordPress and an on-demand WP-CLI', () => {
    expect(document.name).toBe(PROJECT);
    expect(Object.keys(document.services)).toEqual(['db', 'wordpress', 'cli']);
    expect(document.services.db?.image).toBe('mariadb:lts');
    expect(document.services.wordpress?.image).toBe('wordpress:latest');
    expect(document.services.wordpress?.ports).toEqual(['127.0.0.1:8300:80']);
    expect(document.services.cli?.profiles).toEqual(['tools']);
    expect(Object.keys(document.volumes)).toEqual(['db-data', 'wp-data']);
  });

  it('gives WordPress PHP that Compose turns back into single dollars', () => {
    const environment = document.services.wordpress?.environment as Record<string, string>;
    const extra = environment.WORDPRESS_CONFIG_EXTRA ?? '';
    // Compose replaces `$$` with `$` when it reads the file.
    const php = extra.replace(/\$\$/g, '$');
    expect(php).toContain("$_SERVER['HTTPS'] = 'on';");
    expect(php).toContain("define('WP_HOME', 'https://blog.example.com');");
    expect(environment.WORDPRESS_DB_PASSWORD).toBe('${DB_PASSWORD}');
  });

  it('labels every container so the site can be recognised in Docker tools', () => {
    for (const service of Object.values(document.services)) {
      expect(service.labels).toMatchObject({
        'com.cloudforge.managed': 'true',
        'com.cloudforge.kind': 'wordpress',
        'com.cloudforge.domain': 'blog.example.com',
      });
    }
  });
});

describe('WordPress server scripts', () => {
  it.each([
    ['deploy', deploy()],
    ['update', updateWordPressScript(PROJECT)],
    ['status', wordpressStatusScript(PROJECT)],
    ['remove and keep data', removeWordPressScript(PROJECT, false)],
    ['remove with data', removeWordPressScript(PROJECT, true)],
  ])('generates a script that parses: %s', (_name, script) => {
    expect(parsesAsShell(script)).toBe(true);
  });

  it('never carries a password: they arrive as uploaded files, the admin one on stdin', () => {
    const script = deploy();
    expect(script).not.toMatch(/DB_PASSWORD=/);
    // WP-CLI --prompt echoes what it reads, so it must never be used for the password.
    expect(script).not.toContain('--prompt');
    expect(script).toContain('--admin_password="$bootstrap"');
    expect(script).toMatch(/wp eval '.*stream_get_contents\(STDIN\).*' < "\$PASSWORD_FILE"/);
    expect(script).toContain('install -m 600 "$ENV_FILE" "$DIR/.env"');
    expect(script).toContain('trap \'rm -f "$ENV_FILE" "$PASSWORD_FILE"\' EXIT');
  });

  it('quotes what the user typed, so a title cannot run commands', () => {
    expect(deploy()).toContain(`--title='Alex'"'"'s "Bakery" $(reboot)'`);
  });

  it('keeps existing passwords, refuses folders it did not create and ports already in use', () => {
    const script = deploy();
    expect(script).toContain('if [ -s "$DIR/.env" ]; then');
    expect(script).toContain('was not created by CloudForge');
    expect(script).toContain('Port $PORT is already used on this server');
    expect(removeWordPressScript(PROJECT, true)).toContain('was not created by CloudForge');
  });

  it('deletes volumes and files only when asked', () => {
    expect(removeWordPressScript(PROJECT, false)).not.toContain('--volumes');
    expect(removeWordPressScript(PROJECT, false)).not.toContain('rm -rf');
    expect(removeWordPressScript(PROJECT, true)).toContain('down --remove-orphans --volumes');
    expect(removeWordPressScript(PROJECT, true)).toContain('rm -rf "$DIR"');
  });

  it('refuses names, ports and upload paths that could escape the site folder', () => {
    expect(() => wordpressDirectory('../etc')).toThrow();
    expect(() => wordpressDirectory('cloudforge-wp-a;rm')).toThrow();
    expect(() => deploy({ hostPort: 80 })).toThrow();
    expect(() => deploy({ environmentFile: '/etc/shadow' })).toThrow();
  });
});

describe('parseWordPressStatus', () => {
  it('reads containers, the WordPress version and whether it is installed', () => {
    const status = parseWordPressStatus(
      [
        '==> Installing WordPress',
        '@@CONTAINER|db|cloudforge-wp-blog-example-com-db|running|healthy|mariadb:lts',
        '@@CONTAINER|wordpress|cloudforge-wp-blog-example-com-wordpress|running||wordpress:latest',
        '@@VERSION|6.9.1',
        '@@INSTALLED|1',
      ].join('\n'),
    );
    expect(status).toEqual({
      containers: [
        {
          service: 'db',
          name: 'cloudforge-wp-blog-example-com-db',
          state: 'running',
          health: 'healthy',
          image: 'mariadb:lts',
        },
        {
          service: 'wordpress',
          name: 'cloudforge-wp-blog-example-com-wordpress',
          state: 'running',
          health: '',
          image: 'wordpress:latest',
        },
      ],
      wordpressVersion: '6.9.1',
      installed: true,
    });
  });

  it('ignores a version line that is not a version', () => {
    expect(parseWordPressStatus('@@VERSION|PHP Warning: x').wordpressVersion).toBeNull();
    expect(parseWordPressStatus('').installed).toBe(false);
  });
});

describe('lineEvents', () => {
  it('joins chunks into lines, turns ==> lines into steps and hides status lines', () => {
    const events: { stream: string; message: string }[] = [];
    const lines = lineEvents((event) => events.push(event));
    lines.push({ stream: 'stdout', message: '==> Starting the da' });
    lines.push({ stream: 'stdout', message: 'tabase\n@@VERSION|6.9\nCreated' });
    lines.push({ stream: 'stderr', message: 'pull warning\n' });
    lines.flush();
    expect(events).toEqual([
      { stream: 'step', message: 'Starting the database' },
      { stream: 'stderr', message: 'pull warning' },
      { stream: 'stdout', message: 'Created' },
    ]);
  });
});
