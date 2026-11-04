import { describe, expect, it } from 'vitest';
import {
  generateWordPressSecret,
  nextWordPressPort,
  renderWordPressCompose,
  validateWordPressSite,
  WORDPRESS_PROJECT_PATTERN,
  wordpressProject,
  type WordPressSiteInput,
} from './wordpress-site.js';

const input: WordPressSiteInput = {
  targetId: 'target-1',
  domain: ' Blog.Example.COM. ',
  siteTitle: '  Alex Bakery  ',
  adminUser: 'alex',
  adminEmail: 'alex@example.com',
  https: true,
};

describe('validateWordPressSite', () => {
  it('normalizes the domain and title and defaults the certificate email', () => {
    const result = validateWordPressSite(input);
    expect(result.ok && result.value).toMatchObject({
      domain: 'blog.example.com',
      siteTitle: 'Alex Bakery',
      adminPassword: null,
      hostPort: null,
      certificateEmail: 'alex@example.com',
    });
  });

  it.each([
    ['a bare word', { domain: 'localhost' }],
    ['a URL', { domain: 'https://blog.example.com' }],
    ['an empty title', { siteTitle: '   ' }],
    ['a control character in the title', { siteTitle: 'Blog\u0007' }],
    ['a user name with a space', { adminUser: 'al ex' }],
    ['the default admin name', { adminUser: 'Admin' }],
    ['a bad email', { adminEmail: 'alex@' }],
    ['a short password', { adminPassword: 'short' }],
    ['a password with a line break', { adminPassword: 'twelve chars\nlong' }],
    ['a privileged port', { hostPort: 80 }],
    ['a non-integer port', { hostPort: 8300.5 }],
    ['no server', { targetId: ' ' }],
  ])('refuses %s', (_name, change) => {
    expect(validateWordPressSite({ ...input, ...change }).ok).toBe(false);
  });

  it('does not need a certificate email without HTTPS', () => {
    const result = validateWordPressSite({ ...input, https: false, certificateEmail: 'nope' });
    expect(result.ok && result.value.certificateEmail).toBeNull();
  });
});

describe('wordpressProject', () => {
  it('derives a Compose project name the server scripts accept', () => {
    expect(wordpressProject('blog.example.com')).toBe('cloudforge-wp-blog-example-com');
    const long = wordpressProject(`${'a'.repeat(30)}.${'b'.repeat(30)}.example.com`);
    expect(long).toMatch(WORDPRESS_PROJECT_PATTERN);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('nextWordPressPort', () => {
  it('skips ports that other sites use', () => {
    expect(nextWordPressPort([])).toBe(8300);
    expect(nextWordPressPort([8300, 8301, 8303])).toBe(8302);
  });
});

describe('generateWordPressSecret', () => {
  it('uses only characters that need no quoting, and differs every time', () => {
    const first = generateWordPressSecret(32);
    expect(first).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(generateWordPressSecret(32)).not.toBe(first);
  });
});

describe('renderWordPressCompose', () => {
  const yaml = renderWordPressCompose({
    project: 'cloudforge-wp-blog-example-com',
    domain: 'blog.example.com',
    hostPort: 8300,
    siteUrl: 'https://blog.example.com',
  });

  it('publishes WordPress on the loopback port only', () => {
    expect(yaml).toContain('- "127.0.0.1:8300:80"');
    expect(yaml).not.toMatch(/- "?\d+:80"?$/m);
  });

  it('keeps passwords out of the file and escapes PHP variables for Compose', () => {
    expect(yaml).toContain('MARIADB_PASSWORD: ${DB_PASSWORD}');
    expect(yaml).toContain("$$_SERVER['HTTPS'] = 'on';");
    expect(yaml).not.toMatch(/[^$]\$_SERVER/);
    expect(yaml).toContain("define('WP_HOME', 'https://blog.example.com');");
  });

  it('runs WP-CLI as the same user that owns the WordPress files', () => {
    expect(yaml).toContain('image: wordpress:cli');
    expect(yaml).toContain('user: "33:33"');
    expect(yaml).toContain('profiles: ["tools"]');
  });
});
