import type { ManagedNginxSite } from '../ports/nginx-manager.js';

/** What a new site starts with, whichever way it is created. */
export const NEW_NGINX_SITE: ManagedNginxSite = {
  domain: '',
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
};
