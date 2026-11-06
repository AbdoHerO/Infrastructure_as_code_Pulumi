import { writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import {
  cloudflareAddressRecordType,
  cloudflareAnalyticsDates,
  type CloudflarePageRule,
  type CloudflareRedirectRule,
  type ManagedNginxSite,
  NEW_NGINX_SITE,
} from '@cloudforge/core';
import { requireLocalPath } from '../../security/local-paths.js';
import { compact, type McpTool, McpToolError, toolset } from '../types.js';
import { credentialId, environmentVariableNames, id, port, targetId, zoneId } from './common.js';

const nginx = toolset('nginx');
const ssl = toolset('ssl');
const cloudflare = toolset('cloudflare');
const domains = toolset('domains');
const wordpress = toolset('wordpress');
const stacks = toolset('stacks');
const jenkins = toolset('jenkins');

const nginxLog = { logChannel: 'nginx:log' } as const;
const wordpressLog = { logChannel: 'wordpress:log' } as const;
const stacksLog = { logChannel: 'stacks:log' } as const;

const domain = z.string().min(1).describe('Full domain name, e.g. app.example.com');
const backupId = id('Backup id, from nginx_list_backups');
const CERTIFICATE_VOLUME = '/opt/cloudforge/certs';
const WEBROOT_VOLUME = '/opt/cloudforge/www';
const certificateVolume = z.string().min(1).default(CERTIFICATE_VOLUME);
const DNS_POLL_INTERVAL_MS = 5_000;

const siteFields = {
  domain,
  enabled: z.boolean().optional(),
  upstreamKind: z.enum(['host', 'docker']).optional(),
  upstreamHost: z.string().min(1).optional(),
  upstreamPort: port.optional(),
  websocket: z.boolean().optional(),
  ssl: z.boolean().optional(),
  certificatePath: z.string().optional(),
  acmeWebroot: z.string().optional(),
  httpRedirect: z.boolean().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  extraDirectives: z.array(z.string()).optional(),
  locations: z
    .array(
      z.object({
        path: z.string(),
        upstreamHost: z.string().optional(),
        upstreamPort: port.optional(),
        websocket: z.boolean().optional(),
        proxyTimeoutSeconds: z.number().int().positive().optional(),
        extraDirectives: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  proxyTimeoutSeconds: z.number().int().positive().optional(),
  clientMaxBodySize: z.string().optional(),
  compression: z.boolean().optional(),
  cache: z.boolean().optional(),
  customSnippets: z.array(z.string()).optional(),
};

/** Write a file only if nothing is there yet. */
async function writeNewFile(path: string, contentBase64: string): Promise<void> {
  await writeFile(requireLocalPath(path), Buffer.from(contentBase64, 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const NGINX_TOOLS: readonly McpTool[] = [
  nginx.call(
    'nginx_inspect',
    'nginx:inspect',
    'read',
    "A server's Nginx: installed how, running, version, config status, and how many sites.",
    { targetId },
    (input) => input,
  ),
  nginx.call(
    'nginx_list_sites',
    'nginx:listSites',
    'read',
    'Every Nginx site on a server. managed: false means CloudForge did not create it and will not change it.',
    { targetId },
    (input) => input,
  ),
  nginx.custom(
    'nginx_save_site',
    ['nginx:saveSite', 'nginx:listSites'],
    'write',
    'Create or change a site; the config is validated before it goes live. Changing an existing site keeps any field not given.',
    { targetId, ...siteFields },
    async ({ targetId: target, ...fields }, context) => {
      const existing = (await context.call('nginx:listSites', { targetId: target })).find(
        (site) => site.domain === fields.domain,
      );
      const site = {
        ...(existing ?? NEW_NGINX_SITE),
        ...compact(fields),
        lastModified: new Date(context.now()).toISOString(),
      } as ManagedNginxSite;
      return context.call('nginx:saveSite', {
        targetId: target,
        site,
        streamId: context.streamId,
      });
    },
    { operation: nginxLog, idempotent: true },
  ),
  nginx.call(
    'nginx_remove_site',
    'nginx:removeSite',
    'critical',
    'Delete a site. Its domain stops being served.',
    { targetId, domain },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: nginxLog },
  ),
  nginx.call(
    'nginx_read_config',
    'nginx:readConfig',
    'read',
    'The main nginx.conf of a server.',
    { targetId },
    (input) => input,
  ),
  nginx.call(
    'nginx_save_config',
    'nginx:saveConfig',
    'critical',
    'Replace the main nginx.conf. A backup is made and the new file is validated; a mistake here can affect every site on the server.',
    { targetId, content: z.string().min(1) },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: nginxLog },
  ),
  nginx.call(
    'nginx_reload',
    'nginx:reload',
    'write',
    'Test the config and reload Nginx without dropping connections.',
    { targetId },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: nginxLog, idempotent: true },
  ),
  nginx.call(
    'nginx_live_status',
    'nginx:liveStatus',
    'read',
    'Workers, connections, requests and recent errors.',
    { targetId },
    (input) => input,
  ),
  nginx.call(
    'nginx_read_logs',
    'nginx:logs',
    'read',
    'Lines from the access or error log. They contain visitor addresses and URLs.',
    {
      targetId,
      kind: z.enum(['access', 'error']).default('error'),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(10000).default(1000),
    },
    ({ targetId: target, ...query }) => ({ targetId: target, query: compact(query) }),
  ),
  nginx.call(
    'nginx_list_backups',
    'nginx:backups',
    'read',
    'Config backups CloudForge has made on a server.',
    { targetId },
    (input) => input,
  ),
  nginx.call(
    'nginx_read_backup',
    'nginx:readBackupConfig',
    'read',
    'The main config stored in a backup.',
    { targetId, backupId },
    (input) => input,
  ),
  nginx.call(
    'nginx_compare_backup',
    'nginx:compareBackup',
    'read',
    'What differs between a backup and the live main config, line by line.',
    { targetId, backupId },
    (input) => input,
  ),
  nginx.call(
    'nginx_restore_backup',
    'nginx:restore',
    'critical',
    'Put a backup back in place and reload Nginx.',
    { targetId, backupId },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: nginxLog },
  ),
];

export const SSL_TOOLS: readonly McpTool[] = [
  ssl.call(
    'ssl_verify_dns',
    'ssl:verifyDns',
    'read',
    'Whether a domain points at this server yet, which a certificate needs.',
    { targetId, domain, cloudflareCredentialId: credentialId.optional() },
    (input) => compact(input),
  ),
  ssl.custom(
    'ssl_list_certificates',
    ['ssl:list'],
    'read',
    'Certificates on a server, with counts of valid, expiring within 30 days and expired.',
    { targetId, certificateVolume },
    async (input, context) => {
      const certificates = await context.call('ssl:list', input);
      return {
        certificates,
        total: certificates.length,
        valid: certificates.filter((item) => item.daysRemaining > 0).length,
        expiringWithin30Days: certificates.filter(
          (item) => item.daysRemaining > 0 && item.daysRemaining <= 30,
        ).length,
        expired: certificates.filter((item) => item.daysRemaining <= 0).length,
      };
    },
  ),
  ssl.custom(
    'ssl_issue_certificate',
    ['ssl:issue', 'ssl:verifyDns'],
    'write',
    'Issue a certificate for a domain and switch its Nginx site to HTTPS. The domain must be an Nginx site on this server and must already point at it. Origin CA certificates switch the whole Cloudflare zone to Full (strict) unless keepCloudflareSslMode is set.',
    {
      targetId,
      domain,
      authority: z.enum(['letsencrypt', 'cloudflare-origin-ca']).default('letsencrypt'),
      email: z.string().default('').describe("Required for Let's Encrypt"),
      cloudflareCredentialId: credentialId.optional().describe('Required for Origin CA'),
      certificateVolume,
      webrootVolume: z.string().min(1).default(WEBROOT_VOLUME),
      forceRenewal: z.boolean().default(false),
      includeWildcard: z.boolean().optional(),
      keyAlgorithm: z.enum(['rsa', 'ecc']).optional(),
      validityDays: z
        .union([
          z.literal(7),
          z.literal(30),
          z.literal(90),
          z.literal(365),
          z.literal(730),
          z.literal(1095),
          z.literal(5475),
        ])
        .optional(),
      keepCloudflareSslMode: z.boolean().optional(),
      httpRedirect: z.boolean().optional(),
      waitForDnsSeconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .default(0)
        .describe('Wait this long for DNS to reach the server before giving up'),
    },
    async ({ targetId: target, waitForDnsSeconds, ...config }, context) => {
      const deadline = context.now() + waitForDnsSeconds * 1000;
      const check = (): ReturnType<typeof context.call<'ssl:verifyDns'>> =>
        context.call(
          'ssl:verifyDns',
          compact({
            targetId: target,
            domain: config.domain,
            cloudflareCredentialId:
              config.authority === 'cloudflare-origin-ca'
                ? config.cloudflareCredentialId
                : undefined,
          }),
        );
      let dns = await check();
      while (!dns.matches && dns.status === 'pending' && context.now() < deadline) {
        await sleep(DNS_POLL_INTERVAL_MS);
        dns = await check();
      }
      if (!dns.matches) {
        throw new McpToolError(
          `${config.domain} does not point at this server yet: ${dns.message}`,
          'DNS_NOT_READY',
        );
      }
      return context.call('ssl:issue', {
        targetId: target,
        config: compact(config),
        streamId: context.streamId,
      });
    },
    { operation: { logChannel: 'ssl:log' } },
  ),
  ssl.custom(
    'ssl_export_certificate',
    ['ssl:export'],
    'read',
    'Export the public certificate, as text or into a new file. Contains no private key.',
    {
      targetId,
      domain,
      format: z.enum(['pem', 'crt']).default('pem'),
      certificateVolume,
      savePath: z.string().min(1).optional().describe('Complete path of a file to create'),
    },
    async ({ savePath, ...input }, context) => {
      const exported = await context.call('ssl:export', input);
      if (!savePath) return exported;
      await writeNewFile(savePath, exported.contentBase64);
      return { name: exported.name, savedTo: savePath };
    },
  ),
  ssl.custom(
    'ssl_export_private_key',
    ['ssl:export'],
    'secret',
    "Export a certificate's private key, alone or in a zip with the whole certificate.",
    {
      targetId,
      domain,
      format: z.enum(['key', 'zip']).default('key'),
      certificateVolume,
      savePath: z
        .string()
        .min(1)
        .optional()
        .describe('Complete path of a file to create, so the key stays out of this conversation'),
    },
    async ({ savePath, ...input }, context) => {
      const exported = await context.call('ssl:export', input);
      if (!savePath) return exported;
      await writeNewFile(savePath, exported.contentBase64);
      return { name: exported.name, savedTo: savePath };
    },
  ),
  ssl.call(
    'ssl_renew_due_now',
    'ssl:renewDue',
    'write',
    'Renew certificates that are due now instead of waiting for the timer, and reload Nginx.',
    {},
    () => undefined,
    { operation: { logChannel: null }, idempotent: true },
  ),
];

const dnsRecord = {
  type: z.enum([
    'A',
    'AAAA',
    'CNAME',
    'TXT',
    'MX',
    'SRV',
    'CAA',
    'NS',
    'PTR',
    'HTTPS',
    'TLSA',
    'SSHFP',
    'URI',
    'SVCB',
  ]),
  name: z.string().min(1).describe('Full name, e.g. app.example.com'),
  content: z.string().min(1),
  ttl: z.number().int().default(1).describe('1 means automatic'),
  proxied: z
    .boolean()
    .default(false)
    .describe('Through the Cloudflare proxy; only for A, AAAA and CNAME'),
  comment: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().nullable().optional().describe('For MX and URI'),
};
const recordIds = z.array(z.string().min(1)).min(1).describe('From cloudflare_list_dns_records');
const zoneRequest = { credentialId, zoneId };
const ruleStatus = z.enum(['active', 'disabled']).default('active');

export const CLOUDFLARE_TOOLS: readonly McpTool[] = [
  cloudflare.call(
    'cloudflare_test_connection',
    'cloudflare:test',
    'read',
    'Check that a Cloudflare credential works and what it can do.',
    { credentialId },
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_get_dashboard',
    'cloudflare:dashboard',
    'read',
    'Account overview, with counts for one zone when one is given.',
    { credentialId, zoneId: zoneId.optional() },
    (input) => compact(input),
  ),
  cloudflare.call(
    'cloudflare_list_zones',
    'cloudflare:zones',
    'read',
    'Zones (domains) in the account.',
    { credentialId },
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_create_zone',
    'cloudflare:createZone',
    'write',
    'Add a domain to the Cloudflare account.',
    { credentialId, name: z.string().min(1), accountId: z.string().optional() },
    (input) => compact(input),
  ),
  cloudflare.call(
    'cloudflare_delete_zone',
    'cloudflare:deleteZone',
    'critical',
    'Remove a domain and all its DNS records from Cloudflare.',
    zoneRequest,
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_list_dns_records',
    'cloudflare:dnsRecords',
    'read',
    "A zone's DNS records.",
    zoneRequest,
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_create_dns_record',
    'cloudflare:createDnsRecord',
    'write',
    'Create a DNS record.',
    { ...zoneRequest, ...dnsRecord },
    ({ credentialId: credential, zoneId: zone, ...record }) => ({
      credentialId: credential,
      zoneId: zone,
      input: compact(record),
    }),
  ),
  cloudflare.call(
    'cloudflare_update_dns_record',
    'cloudflare:updateDnsRecord',
    'write',
    'Change a DNS record. Give the whole record.',
    { ...zoneRequest, recordId: id('From cloudflare_list_dns_records'), ...dnsRecord },
    ({ credentialId: credential, zoneId: zone, recordId, ...record }) => ({
      credentialId: credential,
      zoneId: zone,
      recordId,
      input: compact(record),
    }),
    { idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_delete_dns_record',
    'cloudflare:deleteDnsRecord',
    'critical',
    'Delete a DNS record.',
    { ...zoneRequest, recordId: id('From cloudflare_list_dns_records') },
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_batch_set_proxy',
    'cloudflare:batchDnsRecords',
    'write',
    'Turn the Cloudflare proxy on or off for several records at once.',
    { ...zoneRequest, recordIds, enabled: z.boolean() },
    ({ credentialId: credential, zoneId: zone, recordIds: ids, enabled }) => ({
      credentialId: credential,
      zoneId: zone,
      action: { kind: 'proxy' as const, recordIds: ids, enabled },
    }),
    { idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_batch_set_ttl',
    'cloudflare:batchDnsRecords',
    'write',
    'Set the TTL of several records at once.',
    { ...zoneRequest, recordIds, ttl: z.number().int() },
    ({ credentialId: credential, zoneId: zone, recordIds: ids, ttl }) => ({
      credentialId: credential,
      zoneId: zone,
      action: { kind: 'ttl' as const, recordIds: ids, ttl },
    }),
    { idempotent: true },
  ),
  cloudflare.custom(
    'cloudflare_batch_repoint',
    ['cloudflare:batchDnsRecords', 'cloudflare:dnsRecords'],
    'critical',
    'Point several records at a new address, moving traffic there. Only records of the matching type change: A for IPv4, AAAA for IPv6.',
    { ...zoneRequest, recordIds, address: z.string().min(1) },
    async ({ credentialId: credential, zoneId: zone, recordIds: ids, address }, context) => {
      const trimmed = address.trim();
      const type = cloudflareAddressRecordType(trimmed);
      const records = await context.call('cloudflare:dnsRecords', {
        credentialId: credential,
        zoneId: zone,
      });
      const matching = ids.filter((recordId) =>
        records.some((record) => record.id === recordId && record.type === type),
      );
      if (matching.length === 0) {
        throw new McpToolError(`None of those records are ${type} records.`);
      }
      const result = await context.call('cloudflare:batchDnsRecords', {
        credentialId: credential,
        zoneId: zone,
        action: { kind: 'address', recordIds: matching, address: trimmed },
      });
      return { ...result, skipped: ids.length - matching.length };
    },
    { idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_batch_delete',
    'cloudflare:batchDnsRecords',
    'critical',
    'Delete several DNS records at once.',
    { ...zoneRequest, recordIds },
    ({ credentialId: credential, zoneId: zone, recordIds: ids }) => ({
      credentialId: credential,
      zoneId: zone,
      action: { kind: 'delete' as const, recordIds: ids },
    }),
  ),
  cloudflare.call(
    'cloudflare_ensure_dns',
    'cloudflare:ensureDns',
    'write',
    'Make a domain point at an address: create or update its record, then wait for it to spread. Uses the default credential and zone from the settings when none is given.',
    {
      domain,
      expectedIp: z.string().min(1),
      credentialId: credentialId.optional(),
      zoneId: zoneId.optional(),
    },
    (input) => compact(input),
    { operation: { logChannel: null }, idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_verify_dns',
    'cloudflare:verifyDns',
    'read',
    'Check whether a domain already points at an address, without changing anything.',
    {
      domain,
      expectedIp: z.string().min(1),
      credentialId: credentialId.optional(),
      zoneId: zoneId.optional(),
    },
    (input) => compact(input),
  ),
  cloudflare.call(
    'cloudflare_withdraw_dns',
    'cloudflare:withdrawDns',
    'critical',
    "Delete a domain's record, only if CloudForge created it for this address. Anything else is left alone.",
    {
      domain,
      expectedIp: z.string().min(1),
      credentialId: credentialId.optional(),
      zoneId: zoneId.optional(),
    },
    (input) => compact(input),
    { idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_list_dns_templates',
    'cloudflare:dnsTemplates',
    'read',
    'Ready-made DNS records for common setups: Laravel, Node, Next.js, WordPress, Mail, API, Subdomain, Load Balancer.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  cloudflare.call(
    'cloudflare_apply_dns_template',
    'cloudflare:applyDnsTemplate',
    'write',
    'Create the record a template describes.',
    {
      ...zoneRequest,
      templateId: id('From cloudflare_list_dns_templates'),
      address: z.string().optional().describe('The server address, for A record templates'),
    },
    (input) => compact(input),
  ),
  cloudflare.call(
    'cloudflare_get_zone_settings',
    'cloudflare:zoneSettings',
    'read',
    "A zone's SSL, cache and security settings.",
    zoneRequest,
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_update_zone_settings',
    'cloudflare:updateZoneSettings',
    'write',
    "Change a zone's settings; only the fields given change. A wrong SSL mode can take its sites offline.",
    {
      ...zoneRequest,
      sslMode: z.enum(['off', 'flexible', 'full', 'strict']).optional(),
      minimumTls: z.enum(['1.0', '1.1', '1.2', '1.3']).optional(),
      tls13: z.boolean().optional(),
      hsts: z.boolean().optional(),
      alwaysHttps: z.boolean().optional(),
      automaticHttpsRewrites: z.boolean().optional(),
      brotli: z.boolean().optional(),
      developmentMode: z.boolean().optional(),
      securityLevel: z.string().optional(),
      browserIntegrityCheck: z.boolean().optional(),
      cacheLevel: z.string().optional(),
      browserCacheTtl: z.number().int().optional(),
    },
    ({ credentialId: credential, zoneId: zone, ...patch }) => ({
      credentialId: credential,
      zoneId: zone,
      patch: compact(patch),
    }),
    { idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_purge_cache',
    'cloudflare:purgeCache',
    'critical',
    "Empty a zone's whole cache. Its sites are slower until it fills again.",
    zoneRequest,
    (input) => input,
    { destructive: false },
  ),
  cloudflare.call(
    'cloudflare_get_security',
    'cloudflare:security',
    'read',
    "A zone's firewall, WAF, rate limits and bot protection.",
    zoneRequest,
    (input) => input,
  ),
  cloudflare.custom(
    'cloudflare_get_analytics',
    ['cloudflare:analytics'],
    'read',
    'Traffic: requests, bandwidth, threats, countries, top URLs. Give a range, or since and until.',
    {
      ...zoneRequest,
      range: z.enum(['today', 'yesterday', '7d', '30d']).default('7d'),
      since: z.string().optional().describe('ISO date; replaces range together with until'),
      until: z.string().optional(),
    },
    async ({ range, since, until, ...request }, context) =>
      context.call('cloudflare:analytics', {
        ...request,
        ...(since && until ? { since, until } : cloudflareAnalyticsDates(range)),
      }),
  ),
  cloudflare.call(
    'cloudflare_list_page_rules',
    'cloudflare:pageRules',
    'read',
    "A zone's page rules.",
    zoneRequest,
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_save_page_rule',
    'cloudflare:savePageRule',
    'write',
    'Create a page rule, or change one by giving its id.',
    {
      ...zoneRequest,
      ruleId: z.string().optional(),
      target: z.string().min(1).describe('URL pattern, e.g. *.example.com/*'),
      actions: z
        .array(z.object({ id: z.string(), value: z.unknown() }))
        .min(1)
        .describe('e.g. [{ "id": "always_use_https", "value": "on" }]'),
      priority: z.number().int().min(1).default(1),
      status: ruleStatus,
    },
    ({ credentialId: credential, zoneId: zone, ruleId, ...rule }) => ({
      credentialId: credential,
      zoneId: zone,
      rule: (ruleId ? { id: ruleId, ...rule } : rule) as CloudflarePageRule,
    }),
    { idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_delete_page_rule',
    'cloudflare:deletePageRule',
    'critical',
    'Delete a page rule.',
    { ...zoneRequest, ruleId: id('From cloudflare_list_page_rules') },
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_list_redirect_rules',
    'cloudflare:redirectRules',
    'read',
    "A zone's redirect rules.",
    zoneRequest,
    (input) => input,
  ),
  cloudflare.call(
    'cloudflare_save_redirect_rule',
    'cloudflare:saveRedirectRule',
    'write',
    'Create a redirect rule, or change one by giving its id.',
    {
      ...zoneRequest,
      ruleId: z.string().optional(),
      source: z.string().min(1).describe('e.g. (http.host eq "example.com")'),
      destination: z.string().min(1),
      status: ruleStatus,
      priority: z.number().int().min(1).default(1),
      statusCode: z
        .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
        .default(301),
      preserveQueryString: z.boolean().default(true),
    },
    ({ credentialId: credential, zoneId: zone, ruleId, ...rule }) => ({
      credentialId: credential,
      zoneId: zone,
      rule: (ruleId ? { id: ruleId, ...rule } : rule) as CloudflareRedirectRule,
    }),
    { idempotent: true },
  ),
  cloudflare.call(
    'cloudflare_delete_redirect_rule',
    'cloudflare:deleteRedirectRule',
    'critical',
    'Delete a redirect rule.',
    { ...zoneRequest, ruleId: id('From cloudflare_list_redirect_rules') },
    (input) => input,
  ),
  cloudflare.custom(
    'cloudflare_get_platform',
    ['cloudflare:platform', 'cloudflare:zones'],
    'read',
    'Workers, R2 buckets, Access applications and Gateway rules. Read only.',
    {
      ...zoneRequest,
      accountId: z.string().optional().describe("Defaults to the zone's account"),
    },
    async ({ credentialId: credential, zoneId: zone, accountId }, context) => {
      const account =
        accountId ??
        (await context.call('cloudflare:zones', { credentialId: credential })).find(
          (item) => item.id === zone,
        )?.accountId;
      if (!account) throw new McpToolError('That zone was not found in this Cloudflare account.');
      return context.call('cloudflare:platform', {
        credentialId: credential,
        zoneId: zone,
        accountId: account,
      });
    },
  ),
];

export const DOMAIN_TOOLS: readonly McpTool[] = [
  domains.call(
    'domains_check',
    'domains:check',
    'read',
    'Whether a domain is free to publish on a server: not used by another application, an Nginx site or a Cloudflare record elsewhere.',
    {
      targetId,
      domain,
      cloudflareCredentialId: credentialId.nullable().optional(),
      cloudflareZoneId: zoneId.nullable().optional(),
    },
    (input) => compact(input),
  ),
];

export const WORDPRESS_TOOLS: readonly McpTool[] = [
  wordpress.call(
    'wordpress_list',
    'wordpress:list',
    'read',
    'WordPress sites in this project.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  wordpress.custom(
    'wordpress_create',
    ['wordpress:create'],
    'write',
    'Deploy a WordPress site with its database on a saved server and publish it on a domain, with DNS and HTTPS. Check the domain with domains_check first. Unless secrets are allowed, the admin password is not returned: it stays in Secrets as "WordPress · domain".',
    {
      targetId,
      domain,
      siteTitle: z.string().min(1).max(100),
      adminUser: z.string().min(3).max(60).describe('Not admin, administrator, root or test'),
      adminEmail: z.string().min(3),
      adminPassword: z
        .string()
        .min(12)
        .optional()
        .describe(
          'Leave out to generate a strong one, which also keeps it out of this conversation',
        ),
      hostPort: z.number().int().min(1024).max(65535).nullable().optional(),
      cloudflareCredentialId: credentialId.nullable().optional(),
      cloudflareZoneId: zoneId.nullable().optional(),
      https: z.boolean().default(true),
      certificateEmail: z.string().nullable().optional(),
    },
    async (input, context) => {
      const created = await context.call('wordpress:create', {
        site: compact(input),
        streamId: context.streamId,
      });
      if (context.settings().tiers.secret) return created;
      return {
        site: created.site,
        adminPassword: `Hidden. Reveal it in CloudForge under Secrets, "WordPress · ${created.site.domain}".`,
      };
    },
    { operation: wordpressLog },
  ),
  wordpress.call(
    'wordpress_redeploy',
    'wordpress:redeploy',
    'write',
    'Run every step again with the same passwords: containers, DNS, Nginx and HTTPS. Use after fixing DNS or a failed step. Content is kept.',
    { id: id('Site id, from wordpress_list') },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: wordpressLog, idempotent: true },
  ),
  wordpress.call(
    'wordpress_update',
    'wordpress:update',
    'write',
    'Update WordPress and its images. The site is offline for a few seconds; content is kept.',
    { id: id('Site id, from wordpress_list') },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: wordpressLog },
  ),
  wordpress.call(
    'wordpress_status',
    'wordpress:status',
    'read',
    'Containers and version of a site.',
    { id: id('Site id, from wordpress_list') },
    (input) => input,
  ),
  wordpress.call(
    'wordpress_remove',
    'wordpress:remove',
    'critical',
    'Stop a site and remove its containers and Nginx site. With deleteData true, also permanently deletes its database, uploads and saved passwords.',
    {
      id: id('Site id, from wordpress_list'),
      deleteData: z.boolean().default(false),
    },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: wordpressLog },
  ),
];

const stackRoute = z.object({
  domain,
  service: z.string().min(1).describe('Service name in the Compose file'),
  containerPort: port,
  hostPort: port.nullable().optional().describe('Chosen automatically when left out'),
  cloudflareCredentialId: credentialId.nullable().optional(),
  cloudflareZoneId: zoneId.nullable().optional(),
  proxied: z.boolean().nullable().optional(),
  https: z.boolean().default(true),
  clientMaxBodySize: z.string().nullable().optional().describe('e.g. 100m'),
});

const folderPath = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Complete path of a folder with the Compose file and .env. CloudForge reads them itself, so the .env never passes through this conversation.',
  );

/** The files of a stack, from a folder or given directly. */
async function stackFiles(
  context: Parameters<McpTool['run']>[1],
  input: {
    readonly folderPath?: string | undefined;
    readonly composeYaml?: string | undefined;
    readonly environment?: string | undefined;
  },
): Promise<{ composeYaml?: string; environment?: string }> {
  if (input.folderPath) {
    const folder = await context.call('stacks:chooseFolder', { path: input.folderPath });
    if (!folder) throw new McpToolError('That folder could not be read.');
    return { composeYaml: folder.composeYaml, environment: folder.environment };
  }
  return compact({ composeYaml: input.composeYaml, environment: input.environment });
}

export const STACK_TOOLS: readonly McpTool[] = [
  stacks.call(
    'stacks_list',
    'stacks:list',
    'read',
    'Docker stacks in this project, with their routes and state.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  stacks.call(
    'stacks_analyze',
    'stacks:analyze',
    'read',
    'Read a Compose file and .env: services, ports, external networks and volumes, and anything that would stop it deploying.',
    { composeYaml: z.string().min(1), environment: z.string().default('') },
    (input) => input,
    { openWorld: false },
  ),
  stacks.custom(
    'stacks_read_folder',
    ['stacks:chooseFolder', 'stacks:analyze'],
    'read',
    'Read a stack folder on this computer: the Compose file, an analysis of it, and the names of the .env variables, never their values.',
    { path: z.string().min(1).describe('Complete path of the folder') },
    async (input, context) => {
      const folder = await context.call('stacks:chooseFolder', { path: input.path });
      if (!folder) throw new McpToolError('That folder could not be read.');
      const analysis = await context.call('stacks:analyze', {
        composeYaml: folder.composeYaml,
        environment: folder.environment,
      });
      return {
        folderName: folder.folderName,
        composeFileName: folder.composeFileName,
        composeYaml: folder.composeYaml,
        hasEnvironment: folder.hasEnvironment,
        environmentVariables: environmentVariableNames(folder.environment),
        analysis,
      };
    },
    { openWorld: false },
  ),
  stacks.custom(
    'stacks_create',
    ['stacks:create', 'stacks:chooseFolder'],
    'write',
    'Deploy a Docker Compose stack on a saved server and publish it on domains, with DNS and HTTPS. Give folderPath, or composeYaml and environment. Check domains with domains_check first.',
    {
      targetId,
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
        .describe('Lowercase letters, digits, - and _'),
      folderPath,
      composeYaml: z.string().min(1).optional(),
      environment: z.string().optional().describe('Contents of the .env file'),
      routes: z.array(stackRoute).default([]).describe('Empty runs the stack with no domain'),
      certificateEmail: z.string().nullable().optional(),
    },
    async ({ folderPath: path, composeYaml, environment, ...stack }, context) => {
      const files = await stackFiles(
        context,
        compact({ folderPath: path, composeYaml, environment }),
      );
      if (!files.composeYaml) throw new McpToolError('Give folderPath or composeYaml.');
      return context.call('stacks:create', {
        stack: {
          ...compact(stack),
          routes: stack.routes.map((route) => compact(route)),
          composeYaml: files.composeYaml,
          environment: files.environment ?? '',
        },
        streamId: context.streamId,
      });
    },
    { operation: stacksLog },
  ),
  stacks.call(
    'stacks_reveal',
    'stacks:reveal',
    'secret',
    "A stack's decrypted Compose file and .env.",
    { id: id('Stack id, from stacks_list') },
    (input) => input,
    { openWorld: false },
  ),
  stacks.custom(
    'stacks_update',
    ['stacks:update', 'stacks:reveal', 'stacks:chooseFolder'],
    'write',
    'Save new files for a stack and redeploy it; a file not given stays as it is. If the new file is invalid, the running stack is left alone. To change domains, remove it and deploy again.',
    {
      id: id('Stack id, from stacks_list'),
      folderPath,
      composeYaml: z.string().min(1).optional(),
      environment: z.string().optional().describe('Contents of the .env file'),
    },
    async ({ id: stackId, folderPath: path, composeYaml, environment }, context) => {
      const files = await stackFiles(
        context,
        compact({ folderPath: path, composeYaml, environment }),
      );
      const stored =
        files.composeYaml === undefined || files.environment === undefined
          ? await context.call('stacks:reveal', { id: stackId })
          : null;
      return context.call('stacks:update', {
        id: stackId,
        composeYaml: files.composeYaml ?? stored?.composeYaml ?? '',
        environment: files.environment ?? stored?.environment ?? '',
        streamId: context.streamId,
      });
    },
    { operation: stacksLog },
  ),
  stacks.call(
    'stacks_redeploy',
    'stacks:redeploy',
    'write',
    'Pull the latest images, restart what changed, and run DNS, Nginx and HTTPS again. Volumes are kept.',
    { id: id('Stack id, from stacks_list') },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: stacksLog, idempotent: true },
  ),
  stacks.call(
    'stacks_status',
    'stacks:status',
    'read',
    "A stack's containers and whether its ports answer.",
    { id: id('Stack id, from stacks_list') },
    (input) => input,
  ),
  stacks.call(
    'stacks_remove',
    'stacks:remove',
    'critical',
    'Stop a stack and remove its containers and Nginx sites. With deleteData true, also permanently deletes its own volumes and files, its DNS records and its saved Compose file. External networks and volumes are always kept.',
    { id: id('Stack id, from stacks_list'), deleteData: z.boolean().default(false) },
    (input, context) => ({ ...input, streamId: context.streamId }),
    { operation: stacksLog },
  ),
];

const pipelineId = id('Pipeline id, from jenkins_list_pipelines');

export const JENKINS_TOOLS: readonly McpTool[] = [
  jenkins.call(
    'jenkins_list_pipelines',
    'jenkins:list',
    'read',
    'Jenkins pipelines in this project.',
    {},
    () => undefined,
  ),
  jenkins.call(
    'jenkins_test_connection',
    'jenkins:test',
    'read',
    'Check that a Jenkins credential works on a target.',
    { targetId, credentialId },
    (input) => input,
  ),
  jenkins.call(
    'jenkins_save_pipeline',
    'jenkins:save',
    'write',
    'Create or change a pipeline in Jenkins and CloudForge; give id to change one. Secrets belong in an environment-file credential, not in environment.',
    {
      id: z.string().optional(),
      name: z.string().min(1),
      description: z.string().default(''),
      targetId,
      jenkinsCredentialId: credentialId,
      definitionMode: z.enum(['scm', 'inline']).default('scm'),
      repositoryUrl: z.string().default(''),
      repositoryAccess: z.enum(['public', 'private']).optional(),
      githubCredentialId: credentialId.nullable().optional(),
      branch: z.string().default('main'),
      jenkinsfilePath: z.string().default('Jenkinsfile'),
      pipelineScript: z.string().default('').describe('Groovy steps, for inline pipelines'),
      parameters: z
        .array(
          z.object({
            name: z.string().min(1),
            type: z.enum(['string', 'boolean', 'choice', 'password']),
            defaultValue: z.string().default(''),
            description: z.string().default(''),
            choices: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      environment: z
        .record(z.string(), z.string())
        .default({})
        .describe('Non-secret environment variables'),
      environmentCredentialId: credentialId.nullable().optional(),
      domain: z.string().default(''),
      applicationPort: port.nullable().optional(),
      cloudflareCredentialId: credentialId.nullable().optional(),
      cloudflareZoneId: zoneId.nullable().optional(),
      configureDomain: z.boolean().default(false),
      applicationRoutes: z.array(z.object({ path: z.string(), port })).optional(),
    },
    (input) => compact(input),
    { operation: { logChannel: null }, idempotent: true },
  ),
  jenkins.call(
    'jenkins_delete_pipeline',
    'jenkins:delete',
    'critical',
    'Delete a pipeline from Jenkins and CloudForge.',
    { id: pipelineId },
    (input) => input,
  ),
  jenkins.call(
    'jenkins_trigger_build',
    'jenkins:trigger',
    'write',
    'Queue a build. Asks for approval when a parameter value is WIPE, which pipelines use to erase data.',
    {
      id: pipelineId,
      parameters: z.record(z.string(), z.string()).default({}),
    },
    (input) => input,
    {
      escalate: (input) =>
        Object.values(input.parameters).some((value) => value.trim().toUpperCase() === 'WIPE'),
    },
  ),
  jenkins.call(
    'jenkins_get_status',
    'jenkins:status',
    'read',
    "A pipeline's job state, last build and the parameters Jenkins found in its Jenkinsfile.",
    { id: pipelineId },
    (input) => input,
  ),
];
