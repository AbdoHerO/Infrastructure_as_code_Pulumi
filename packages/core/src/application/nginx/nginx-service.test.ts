import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { ManagedNginxSite, NginxManager } from '../ports/nginx-manager.js';
import {
  decodeManagedNginxSite,
  encodeManagedNginxSite,
  inferUpstreamKind,
  NGINX_SITE_MARKER,
  NginxService,
  renderManagedNginxSite,
  validateManagedNginxSite,
} from './nginx-service.js';

const encodeLegacy = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:test',
};
const site: ManagedNginxSite = {
  domain: 'app.example.com',
  enabled: true,
  upstreamKind: 'host',
  upstreamHost: '127.0.0.1',
  upstreamPort: 3000,
  websocket: true,
  ssl: false,
  httpRedirect: false,
  headers: [],
  extraDirectives: [],
  locations: [],
  proxyTimeoutSeconds: 60,
  clientMaxBodySize: '10m',
  compression: true,
  cache: false,
  customSnippets: [],
  lastModified: null,
};

describe('NginxService', () => {
  it('validates and renders a managed reverse proxy without React business logic', () => {
    expect(validateManagedNginxSite(site).ok).toBe(true);
    expect(renderManagedNginxSite(site)).toContain('proxy_pass http://127.0.0.1:3000;');
    expect(renderManagedNginxSite(site)).toContain('proxy_set_header Upgrade $http_upgrade;');
  });

  describe('upstreamKind', () => {
    // It answers "could a proxy that is not on a Docker network resolve this?".
    // The only evidence is the host, so it is derived rather than believed — a
    // stored value that disagreed with the host it described would be worse
    // than no value, because everything downstream would trust it.
    it('is derived from the host, not taken from the caller', () => {
      const lying = validateManagedNginxSite({
        ...site,
        upstreamHost: 'api-container',
        upstreamKind: 'host',
      });

      expect(lying.ok && lying.value.upstreamKind).toBe('docker');
    });

    it('corrects a host upstream mislabelled as docker', () => {
      const lying = validateManagedNginxSite({
        ...site,
        upstreamHost: '127.0.0.1',
        upstreamKind: 'docker',
      });

      expect(lying.ok && lying.value.upstreamKind).toBe('host');
    });

    it('classifies the upstream from its address', () => {
      expect(inferUpstreamKind('127.0.0.1')).toBe('host');
      expect(inferUpstreamKind('localhost')).toBe('host');
      expect(inferUpstreamKind('db.internal.example.com')).toBe('host');
      expect(inferUpstreamKind('10.0.0.5')).toBe('host');
      // A bare single-label name is only meaningful inside a Docker network.
      expect(inferUpstreamKind('api')).toBe('docker');
      expect(inferUpstreamKind('shop-redis')).toBe('docker');
    });
  });

  it('rejects directives capable of escaping the generated block', () => {
    expect(validateManagedNginxSite({ ...site, extraDirectives: ['include bad;\n}'] }).ok).toBe(
      false,
    );
  });

  it('keeps the ACME challenge reachable before an HTTPS redirect', () => {
    const rendered = renderManagedNginxSite({
      ...site,
      ssl: true,
      httpRedirect: true,
      acmeWebroot: '/opt/cloudforge/www',
    });
    expect(rendered).toContain('location ^~ /.well-known/acme-challenge/');
    expect(rendered).toContain('root /opt/cloudforge/www;');
    expect(rendered).toContain('return 301 https://$host$request_uri;');
  });

  it('renders WebSocket application routes in the HTTPS server', () => {
    const rendered = renderManagedNginxSite({
      ...site,
      ssl: true,
      httpRedirect: true,
      locations: [
        {
          path: '/app',
          upstreamHost: '127.0.0.1',
          upstreamPort: 8081,
          websocket: true,
          proxyTimeoutSeconds: 3_600,
        },
      ],
    });
    const httpsServer = rendered.slice(rendered.indexOf('listen 443 ssl http2;'));
    expect(httpsServer).toContain('location /app {');
    expect(httpsServer).toContain('proxy_pass http://127.0.0.1:8081;');
    expect(httpsServer).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(httpsServer).toContain('proxy_set_header Connection "upgrade";');
    expect(httpsServer).toContain('proxy_read_timeout 3600s;');
  });

  it('resolves saved target credentials and delegates a rendered transaction', async () => {
    const applySite = vi.fn().mockResolvedValue(ok({ summary: 'done', backupId: 'backup' }));
    const listSites = vi.fn().mockResolvedValue(ok([{ ...site, managed: true }]));
    const manager = { applySite, listSites } as unknown as NginxManager;
    const recordSafe = vi.fn();
    const replaceRoutes = vi.fn().mockResolvedValue(ok(undefined));
    const activity = { recordSafe } as unknown as ActivityService;
    const service = new NginxService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      manager,
      activity,
      { replaceRoutes } as never,
    );
    const result = await service.saveSite('target-1', site);
    expect(result.ok).toBe(true);
    expect(applySite).toHaveBeenCalledWith(
      target,
      site,
      expect.stringContaining('server_name app.example.com;'),
      undefined,
    );
    expect(recordSafe.mock.calls).toHaveLength(1);
    expect(replaceRoutes).toHaveBeenCalledWith('target-1', [
      expect.objectContaining({
        domain: 'app.example.com',
        path: '/',
        upstreamHost: '127.0.0.1',
        upstreamPort: 3000,
        ownership: 'cloudforge-managed',
      }),
    ]);
  });
});

describe('managed site metadata', () => {
  it('round-trips a site through the encoded comment', () => {
    const decoded = decodeManagedNginxSite(encodeManagedNginxSite(site));

    expect(decoded).toEqual(site);
  });

  it('stamps a schema version alongside the site fields', () => {
    const payload = JSON.parse(
      Buffer.from(encodeManagedNginxSite(site), 'base64').toString('utf8'),
    ) as Record<string, unknown>;

    // Alongside, not wrapping: an older reader spreads this object straight
    // into a site and must still find `domain` at the top level.
    expect(payload.schemaVersion).toBe(1);
    expect(payload.domain).toBe('app.example.com');
  });

  it('reads an unversioned site written before versioning existed', () => {
    // The file on the VPS is the only record of a site, so a reader must cope
    // with anything an earlier release wrote.
    const legacy = encodeLegacy({
      domain: 'legacy.example.com',
      enabled: true,
      upstreamKind: 'host',
      upstreamHost: '127.0.0.1',
      upstreamPort: 8080,
      websocket: false,
      ssl: false,
      httpRedirect: false,
      headers: [],
      extraDirectives: [],
      locations: [],
      proxyTimeoutSeconds: 60,
      clientMaxBodySize: '10m',
      compression: true,
      cache: false,
      customSnippets: [],
      lastModified: null,
    });

    expect(decodeManagedNginxSite(legacy)).toMatchObject({
      domain: 'legacy.example.com',
      upstreamPort: 8080,
    });
  });

  it('defaults every field absent from an older payload', () => {
    // This is what lets the model gain fields without invalidating sites
    // already deployed: a missing field becomes its default, not undefined.
    const decoded = decodeManagedNginxSite(
      encodeLegacy({ domain: 'minimal.example.com', upstreamPort: 3000 }),
    );

    expect(decoded).toEqual({
      domain: 'minimal.example.com',
      enabled: true,
      upstreamKind: 'host',
      upstreamHost: '127.0.0.1',
      upstreamPort: 3000,
      websocket: false,
      ssl: false,
      httpRedirect: false,
      headers: [],
      extraDirectives: [],
      locations: [],
      proxyTimeoutSeconds: 60,
      clientMaxBodySize: '10m',
      compression: true,
      cache: false,
      customSnippets: [],
      lastModified: null,
    });
  });

  it('ignores an unknown field from a newer writer', () => {
    const decoded = decodeManagedNginxSite(
      encodeLegacy({ ...site, schemaVersion: 99, somethingFromTheFuture: { nested: true } }),
    );

    expect(decoded).toEqual(site);
  });

  it('does not persist adapter-derived fields', () => {
    const payload = JSON.parse(
      Buffer.from(
        encodeManagedNginxSite({ ...site, managed: true, configPath: '/etc/nginx/conf.d/x.conf' }),
        'base64',
      ).toString('utf8'),
    ) as Record<string, unknown>;

    // `managed` and `configPath` describe where a file was found, not what the
    // site should be; persisting them would let a stale value survive a move.
    expect(payload).not.toHaveProperty('managed');
    expect(payload).not.toHaveProperty('configPath');
  });

  it('returns null rather than a half-built model for unusable payloads', () => {
    expect(decodeManagedNginxSite('not-base64-@@@')).toBeNull();
    expect(decodeManagedNginxSite(encodeLegacy({ upstreamPort: 3000 }))).toBeNull();
    expect(decodeManagedNginxSite(encodeLegacy(['an', 'array']))).toBeNull();
    expect(decodeManagedNginxSite(encodeLegacy('a string'))).toBeNull();
  });

  it('rejects a payload with junk in a list field', () => {
    const decoded = decodeManagedNginxSite(
      encodeLegacy({ ...site, headers: [{ name: 'X-A', value: 'b' }, 'junk', null], locations: 7 }),
    );

    expect(decoded?.headers).toEqual([{ name: 'X-A', value: 'b' }]);
    expect(decoded?.locations).toEqual([]);
  });

  it('is emitted behind the marker the reader greps for', () => {
    expect(renderManagedNginxSite(site)).toContain(NGINX_SITE_MARKER);
  });
});

describe('inferUpstreamKind', () => {
  it('treats loopback, IP literals and dotted names as host addresses', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '[::1]', 'db.example.com']) {
      expect(inferUpstreamKind(host), host).toBe('host');
    }
  });

  it('treats a bare single-label name as a container alias', () => {
    // Only resolvable inside a Docker network — categorically not a host.
    for (const host of ['api', 'hanoutplus-app', 'redis']) {
      expect(inferUpstreamKind(host), host).toBe('docker');
    }
  });
});

describe('renderManagedNginxSite HTTPS block', () => {
  const routed: ManagedNginxSite = {
    ...site,
    ssl: true,
    httpRedirect: false,
    certificatePath: '/opt/cloudforge/certs/live/app.example.com',
    headers: [{ name: 'X-Custom', value: 'yes' }],
    proxyTimeoutSeconds: 120,
    locations: [{ path: '/app', upstreamHost: '127.0.0.1', upstreamPort: 8081 }],
    customSnippets: ['add_header X-Snippet always'],
  };

  it('serves additional routes over HTTPS, not only over HTTP', () => {
    const rendered = renderManagedNginxSite(routed);
    const https = rendered.slice(rendered.indexOf('listen 443'));

    // Enabling TLS previously dropped every additional route, so a websocket or
    // API path declared by a pipeline stopped resolving the moment SSL landed.
    expect(https).toContain('location /app {');
    expect(https).toContain('proxy_pass http://127.0.0.1:8081;');
  });

  it('applies headers, timeouts and snippets to the HTTPS block', () => {
    const rendered = renderManagedNginxSite(routed);
    const https = rendered.slice(rendered.indexOf('listen 443'));

    expect(https).toContain('proxy_set_header X-Custom yes;');
    expect(https).toContain('proxy_read_timeout 120s;');
    expect(https).toContain('gzip on;');
    expect(https).toContain('add_header X-Snippet always;');
  });

  it('carries websocket upgrade headers on additional routes', () => {
    const rendered = renderManagedNginxSite(routed);
    const route = rendered.slice(rendered.indexOf('location /app {'));

    // A route to a websocket service is useless without the upgrade handshake.
    expect(route).toContain('proxy_set_header Upgrade $http_upgrade;');
  });

  it('renders identical proxy bodies for HTTP and HTTPS', () => {
    const rendered = renderManagedNginxSite(routed);
    const [http, https] = rendered.split('listen 443 ssl http2;');
    const locations = (block: string): string[] =>
      [...block.matchAll(/location (\S+) \{/g)].map((match) => match[1]!);

    expect(locations(http ?? '')).toEqual(locations(https ?? ''));
  });

  it('still redirects instead of proxying when httpRedirect is set', () => {
    const rendered = renderManagedNginxSite({ ...routed, httpRedirect: true });
    const http = rendered.slice(0, rendered.indexOf('listen 443'));

    expect(http).toContain('return 301 https://$host$request_uri;');
    expect(http).not.toContain('location /app {');
  });
});
