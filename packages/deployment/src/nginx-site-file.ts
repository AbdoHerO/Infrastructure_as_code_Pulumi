/**
 * File conventions for CloudForge-owned Nginx sites.
 *
 * Two writers manage domain-to-upstream routes on a VPS: the Nginx Manager and
 * the Ansible domain tab. They previously used different file names and
 * different metadata comments for the same domain, so a site created by one was
 * invisible to the other — and SSL, which only recognises the Nginx Manager's
 * format, refused to issue for a domain created by the Ansible tab. Worse, a
 * domain saved through both ended up in two files with the same `server_name`,
 * which Nginx resolves by silently ignoring one.
 *
 * Both writers now share the conventions in this module.
 */
import type { ManagedNginxSite, NginxSite } from '@cloudforge/core';
import { inferUpstreamKind } from '@cloudforge/core';

const CONF_DIR = '/etc/nginx/conf.d';

/** The owned file for a domain. Wildcards cannot be a file name, so they are spelled out. */
export function managedSiteFilePath(domain: string): string {
  const safeName = domain.replace(/^\*\./, 'wildcard.').replace(/[^a-z0-9.-]/gi, '-');
  return `${CONF_DIR}/cloudforge-${safeName}.conf`;
}

/**
 * The name the Ansible domain tab used before both writers were unified.
 *
 * Still needed on every write and delete: a file left behind under the old name
 * keeps its `server_name`, and two files claiming one host is a conflict Nginx
 * resolves by ignoring one of them — unpredictably, from the user's point of
 * view.
 */
export function legacyAnsibleSiteFilePath(domain: string): string {
  return `${CONF_DIR}/cloudforge-${domain.replaceAll('.', '-')}.conf`;
}

/** Every path a domain's configuration could occupy, current convention first. */
export function siteFilePaths(domain: string): readonly string[] {
  const current = managedSiteFilePath(domain);
  const legacy = legacyAnsibleSiteFilePath(domain);
  return legacy === current ? [current] : [current, legacy];
}

/**
 * Widen the Ansible tab's four-field site into the full model.
 *
 * When the domain already exists, its other settings are preserved: the tab
 * edits a route, and must not silently clear the TLS, header or extra-route
 * configuration a user set through the Nginx Manager.
 */
export function toManagedNginxSite(
  site: NginxSite,
  existing?: ManagedNginxSite,
  now: Date = new Date(),
): ManagedNginxSite {
  const route = {
    domain: site.domain,
    upstreamKind: inferUpstreamKind(site.upstreamHost),
    upstreamHost: site.upstreamHost,
    upstreamPort: site.upstreamPort,
    websocket: site.websocket,
    lastModified: now.toISOString(),
  };
  if (existing) return { ...existing, ...route, enabled: true };
  return {
    ...route,
    enabled: true,
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
  };
}

/** Narrow the full model back to the four fields the Ansible tab presents. */
export function toNginxSite(site: ManagedNginxSite): NginxSite {
  return {
    domain: site.domain,
    upstreamHost: site.upstreamHost,
    upstreamPort: site.upstreamPort,
    websocket: site.websocket,
  };
}
