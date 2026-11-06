import type { CloudflareDnsRecordInput, CloudflareDnsType } from './cloudflare.js';

export interface CloudflareDnsTemplate {
  readonly id: string;
  readonly label: string;
  readonly type: CloudflareDnsType;
  /** Left of the zone name; empty for the zone itself. */
  readonly prefix: string;
  readonly proxied: boolean;
}

/** Generic starting points for common DNS records. */
export const CLOUDFLARE_DNS_TEMPLATES: readonly CloudflareDnsTemplate[] = [
  { id: 'laravel', label: 'Laravel', type: 'A', prefix: 'app', proxied: true },
  { id: 'node', label: 'Node', type: 'A', prefix: 'node', proxied: true },
  { id: 'nextjs', label: 'Next.js', type: 'CNAME', prefix: 'www', proxied: true },
  { id: 'wordpress', label: 'WordPress', type: 'A', prefix: '', proxied: true },
  { id: 'mail', label: 'Mail', type: 'MX', prefix: '', proxied: false },
  { id: 'api', label: 'API', type: 'A', prefix: 'api', proxied: true },
  { id: 'subdomain', label: 'Subdomain', type: 'CNAME', prefix: 'subdomain', proxied: true },
  { id: 'load-balancer', label: 'Load Balancer', type: 'CNAME', prefix: 'app', proxied: true },
];

/** The record a template describes in a given zone. */
export function cloudflareDnsTemplateRecord(
  template: CloudflareDnsTemplate,
  zoneName: string,
  address: string,
): CloudflareDnsRecordInput {
  return {
    type: template.type,
    name: template.prefix ? `${template.prefix}.${zoneName}` : zoneName,
    content:
      template.type === 'MX' ? `mail.${zoneName}` : template.type === 'CNAME' ? zoneName : address,
    ttl: 1,
    proxied: template.proxied,
    comment: `${template.label} template managed by CloudForge`,
    ...(template.type === 'MX' ? { priority: 10 } : {}),
  };
}

export type CloudflareAnalyticsRange = 'today' | 'yesterday' | '7d' | '30d';

/** The dates of a named analytics range, in this computer's time zone. */
export function cloudflareAnalyticsDates(
  range: CloudflareAnalyticsRange,
  now: Date = new Date(),
): { since: string; until: string } {
  if (range === 'today')
    return {
      since: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
      until: now.toISOString(),
    };
  if (range === 'yesterday')
    return {
      since: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString(),
      until: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    };
  return {
    since: new Date(now.getTime() - (range === '30d' ? 30 : 7) * 86400000).toISOString(),
    until: now.toISOString(),
  };
}

/** Repointing records to an address only applies to the matching record type. */
export function cloudflareAddressRecordType(address: string): 'A' | 'AAAA' {
  return address.includes(':') ? 'AAAA' : 'A';
}
