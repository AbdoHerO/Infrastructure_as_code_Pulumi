import { describe, expect, it, vi } from 'vitest';
import { ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { ManagedNginxSite, NginxManager } from '../ports/nginx-manager.js';
import { NginxService, renderManagedNginxSite, validateManagedNginxSite } from './nginx-service.js';

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
    const manager = { applySite } as unknown as NginxManager;
    const recordSafe = vi.fn();
    const activity = { recordSafe } as unknown as ActivityService;
    const service = new NginxService(
      { resolve: vi.fn().mockResolvedValue(ok(target)) },
      manager,
      activity,
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
  });
});
