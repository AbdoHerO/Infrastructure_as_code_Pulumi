import type { Result, ServiceProviderError } from '@cloudforge/shared';
import type { ServiceProvider } from './service-provider.js';

export type CloudflareDnsType =
  | 'A'
  | 'AAAA'
  | 'CNAME'
  | 'TXT'
  | 'MX'
  | 'SRV'
  | 'CAA'
  | 'NS'
  | 'PTR'
  | 'HTTPS'
  | 'TLSA'
  | 'SSHFP'
  | 'URI'
  | 'SVCB';

export interface CloudflareAccount {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

export interface CloudflareZone {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly plan: string;
  readonly developmentMode: number;
  readonly nameServers: readonly string[];
  readonly createdAt: string;
  readonly accountId: string;
  readonly accountName: string;
}

export interface CloudflareDnsRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly type: CloudflareDnsType;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly proxiable: boolean;
  readonly comment: string;
  readonly tags: readonly string[];
  readonly priority: number | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface CloudflareDnsRecordInput {
  readonly type: CloudflareDnsType;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly comment?: string;
  readonly tags?: readonly string[];
  readonly priority?: number | null;
}

export type CloudflareDnsBatchAction =
  | { readonly kind: 'delete'; readonly recordIds: readonly string[] }
  | { readonly kind: 'proxy'; readonly recordIds: readonly string[]; readonly enabled: boolean }
  | { readonly kind: 'ttl'; readonly recordIds: readonly string[]; readonly ttl: number };

export interface CloudflareZoneSettings {
  readonly sslMode: 'off' | 'flexible' | 'full' | 'strict';
  readonly minimumTls: '1.0' | '1.1' | '1.2' | '1.3';
  readonly tls13: boolean;
  readonly hsts: boolean;
  readonly alwaysHttps: boolean;
  readonly automaticHttpsRewrites: boolean;
  readonly brotli: boolean;
  readonly developmentMode: boolean;
  readonly securityLevel: string;
  readonly browserIntegrityCheck: boolean;
  readonly cacheLevel: string;
  readonly browserCacheTtl: number;
}

export interface CloudflareDashboard {
  readonly account: CloudflareAccount;
  readonly connected: boolean;
  readonly apiStatus: string;
  readonly zones: number;
  readonly dnsRecords: number | null;
  readonly plan: string;
  readonly sslMode: string;
  readonly proxiedRecords: number | null;
  readonly firewallRules: number | null;
  readonly pageRules: number | null;
  readonly cacheStatus: string;
  readonly lastSynchronization: string;
  readonly warnings: readonly string[];
}

export interface CloudflareSecurityOverview {
  readonly wafStatus: string;
  readonly securityLevel: string;
  readonly browserIntegrityCheck: boolean;
  readonly underAttackMode: boolean;
  readonly rules: readonly { id: string; name: string; phase: string; status: string }[];
  readonly rateLimits: number;
  readonly ipLists: number;
  readonly countryBlocks: number;
  readonly ddosStatus: string;
  readonly botProtection: string;
}

export interface CloudflareAnalytics {
  readonly since: string;
  readonly until: string;
  readonly requests: number;
  readonly bandwidth: number;
  readonly threats: number;
  readonly cachedRequests: number;
  readonly visitors: number;
  readonly countries: readonly { readonly name: string; readonly requests: number }[];
  readonly topUrls: readonly { readonly path: string; readonly requests: number }[];
  readonly statusCodes: readonly { readonly status: number; readonly requests: number }[];
  readonly series: readonly {
    readonly date: string;
    readonly requests: number;
    readonly bandwidth: number;
    readonly cachedRequests: number;
    readonly threats: number;
    readonly visitors: number;
  }[];
}

export interface CloudflarePageRule {
  readonly id: string;
  readonly target: string;
  readonly actions: readonly { id: string; value: unknown }[];
  readonly priority: number;
  readonly status: 'active' | 'disabled';
}

export interface CloudflareRedirectRule {
  readonly id: string;
  readonly source: string;
  readonly destination: string;
  readonly status: 'active' | 'disabled';
  readonly priority: number;
  readonly statusCode: 301 | 302 | 307 | 308;
  readonly preserveQueryString: boolean;
}

export interface CloudflarePlatformSummary {
  readonly workers: readonly {
    id: string;
    status: string;
    createdAt: string;
    modifiedAt: string;
  }[];
  readonly workerRoutes: readonly { id: string; pattern: string; script: string | null }[];
  readonly r2Buckets: readonly {
    name: string;
    createdAt: string;
    objectCount: number | null;
    sizeBytes: number | null;
  }[];
  readonly accessApplications: readonly { id: string; name: string; domain: string }[];
  readonly accessPolicies: readonly {
    id: string;
    applicationId: string;
    name: string;
    decision: string;
  }[];
  readonly gatewayRules: readonly { id: string; name: string; enabled: boolean }[];
}

export interface CloudflareOriginCertificateInput {
  readonly csr: string;
  readonly hostnames: readonly string[];
  readonly requestType: 'origin-rsa' | 'origin-ecc';
  readonly validityDays: 7 | 30 | 90 | 365 | 730 | 1095 | 5475;
}

export interface CloudflareOriginCertificate {
  readonly id: string;
  readonly certificate: string;
  readonly hostnames: readonly string[];
  readonly expiresAt: string;
  readonly requestType: 'origin-rsa' | 'origin-ecc';
}

export interface CloudflareProvider extends ServiceProvider {
  readonly kind: 'cloudflare';
  account(): Promise<Result<CloudflareAccount, ServiceProviderError>>;
  zones(): Promise<Result<readonly CloudflareZone[], ServiceProviderError>>;
  createZone(
    name: string,
    accountId?: string,
  ): Promise<Result<CloudflareZone, ServiceProviderError>>;
  deleteZone(zoneId: string): Promise<Result<void, ServiceProviderError>>;
  dashboard(zoneId?: string): Promise<Result<CloudflareDashboard, ServiceProviderError>>;
  dnsRecords(zoneId: string): Promise<Result<readonly CloudflareDnsRecord[], ServiceProviderError>>;
  createDnsRecord(
    zoneId: string,
    input: CloudflareDnsRecordInput,
  ): Promise<Result<CloudflareDnsRecord, ServiceProviderError>>;
  updateDnsRecord(
    zoneId: string,
    recordId: string,
    input: CloudflareDnsRecordInput,
  ): Promise<Result<CloudflareDnsRecord, ServiceProviderError>>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<Result<void, ServiceProviderError>>;
  zoneSettings(zoneId: string): Promise<Result<CloudflareZoneSettings, ServiceProviderError>>;
  updateZoneSettings(
    zoneId: string,
    patch: Partial<CloudflareZoneSettings>,
  ): Promise<Result<CloudflareZoneSettings, ServiceProviderError>>;
  purgeCache(zoneId: string): Promise<Result<void, ServiceProviderError>>;
  security(zoneId: string): Promise<Result<CloudflareSecurityOverview, ServiceProviderError>>;
  analytics(
    zoneId: string,
    since: string,
    until: string,
  ): Promise<Result<CloudflareAnalytics, ServiceProviderError>>;
  pageRules(zoneId: string): Promise<Result<readonly CloudflarePageRule[], ServiceProviderError>>;
  createPageRule(
    zoneId: string,
    input: Omit<CloudflarePageRule, 'id'>,
  ): Promise<Result<CloudflarePageRule, ServiceProviderError>>;
  updatePageRule(
    zoneId: string,
    rule: CloudflarePageRule,
  ): Promise<Result<CloudflarePageRule, ServiceProviderError>>;
  deletePageRule(zoneId: string, ruleId: string): Promise<Result<void, ServiceProviderError>>;
  redirectRules(
    zoneId: string,
  ): Promise<Result<readonly CloudflareRedirectRule[], ServiceProviderError>>;
  saveRedirectRule(
    zoneId: string,
    rule: CloudflareRedirectRule | Omit<CloudflareRedirectRule, 'id'>,
  ): Promise<Result<CloudflareRedirectRule, ServiceProviderError>>;
  deleteRedirectRule(zoneId: string, ruleId: string): Promise<Result<void, ServiceProviderError>>;
  platform(
    zoneId: string,
    accountId: string,
  ): Promise<Result<CloudflarePlatformSummary, ServiceProviderError>>;
  createOriginCertificate(
    input: CloudflareOriginCertificateInput,
  ): Promise<Result<CloudflareOriginCertificate, ServiceProviderError>>;
}
