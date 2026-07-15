import type { CloudflareService } from '@cloudforge/core';
import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import { orThrow } from '../result.js';

export function registerCloudflareHandlers(): void {
  const service = (): CloudflareService => getContainer().cloudflareService;
  registerHandler('cloudflare:test', async ({ credentialId }) =>
    orThrow(await service().test(credentialId)),
  );
  registerHandler('cloudflare:dashboard', async ({ credentialId, zoneId }) =>
    orThrow(await service().dashboard(credentialId, zoneId)),
  );
  registerHandler('cloudflare:zones', async ({ credentialId }) =>
    orThrow(await service().zones(credentialId)),
  );
  registerHandler('cloudflare:createZone', async ({ credentialId, name, accountId }) =>
    orThrow(await service().createZone(credentialId, name, accountId)),
  );
  registerHandler('cloudflare:deleteZone', async ({ credentialId, zoneId }) =>
    orThrow(await service().deleteZone(credentialId, zoneId)),
  );
  registerHandler('cloudflare:dnsRecords', async ({ credentialId, zoneId }) =>
    orThrow(await service().dnsRecords(credentialId, zoneId)),
  );
  registerHandler('cloudflare:createDnsRecord', async ({ credentialId, zoneId, input }) =>
    orThrow(await service().createDnsRecord(credentialId, zoneId, input)),
  );
  registerHandler('cloudflare:updateDnsRecord', async ({ credentialId, zoneId, recordId, input }) =>
    orThrow(await service().updateDnsRecord(credentialId, zoneId, recordId, input)),
  );
  registerHandler('cloudflare:deleteDnsRecord', async ({ credentialId, zoneId, recordId }) =>
    orThrow(await service().deleteDnsRecord(credentialId, zoneId, recordId)),
  );
  registerHandler('cloudflare:batchDnsRecords', async ({ credentialId, zoneId, action }) =>
    orThrow(await service().batchDnsRecords(credentialId, zoneId, action)),
  );
  registerHandler('cloudflare:ensureDns', async ({ credentialId, zoneId, domain, expectedIp }) =>
    orThrow(
      await getContainer().cloudflareDnsAutomationService.ensure(
        domain,
        expectedIp,
        credentialId,
        zoneId,
      ),
    ),
  );
  registerHandler('cloudflare:verifyDns', async ({ credentialId, zoneId, domain, expectedIp }) =>
    orThrow(
      await getContainer().cloudflareDnsAutomationService.verify(
        domain,
        expectedIp,
        credentialId,
        zoneId,
      ),
    ),
  );
  registerHandler('cloudflare:zoneSettings', async ({ credentialId, zoneId }) =>
    orThrow(await service().zoneSettings(credentialId, zoneId)),
  );
  registerHandler('cloudflare:updateZoneSettings', async ({ credentialId, zoneId, patch }) =>
    orThrow(await service().updateZoneSettings(credentialId, zoneId, patch)),
  );
  registerHandler('cloudflare:purgeCache', async ({ credentialId, zoneId }) =>
    orThrow(await service().purgeCache(credentialId, zoneId)),
  );
  registerHandler('cloudflare:security', async ({ credentialId, zoneId }) =>
    orThrow(await service().security(credentialId, zoneId)),
  );
  registerHandler('cloudflare:analytics', async ({ credentialId, zoneId, since, until }) =>
    orThrow(await service().analytics(credentialId, zoneId, since, until)),
  );
  registerHandler('cloudflare:pageRules', async ({ credentialId, zoneId }) =>
    orThrow(await service().pageRules(credentialId, zoneId)),
  );
  registerHandler('cloudflare:savePageRule', async ({ credentialId, zoneId, rule }) =>
    orThrow(await service().savePageRule(credentialId, zoneId, rule)),
  );
  registerHandler('cloudflare:deletePageRule', async ({ credentialId, zoneId, ruleId }) =>
    orThrow(await service().deletePageRule(credentialId, zoneId, ruleId)),
  );
  registerHandler('cloudflare:redirectRules', async ({ credentialId, zoneId }) =>
    orThrow(await service().redirectRules(credentialId, zoneId)),
  );
  registerHandler('cloudflare:saveRedirectRule', async ({ credentialId, zoneId, rule }) =>
    orThrow(await service().saveRedirectRule(credentialId, zoneId, rule)),
  );
  registerHandler('cloudflare:deleteRedirectRule', async ({ credentialId, zoneId, ruleId }) =>
    orThrow(await service().deleteRedirectRule(credentialId, zoneId, ruleId)),
  );
  registerHandler('cloudflare:platform', async ({ credentialId, zoneId, accountId }) =>
    orThrow(await service().platform(credentialId, zoneId, accountId)),
  );
}
