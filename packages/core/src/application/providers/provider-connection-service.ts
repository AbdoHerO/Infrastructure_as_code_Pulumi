import { err, ProviderError, type Result } from '@cloudforge/shared';
import { isProviderKind } from '../../domain/provider/provider-kind.js';
import type { ProviderFactory } from '../ports/provider-factory.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type {
  AvailabilityDomain,
  CloudResource,
  CloudInstance,
  CloudProvider,
  ConnectionTestResult,
  Region,
  InstanceAction,
  Shape,
  LiveFirewallRule,
  InstanceFirewall,
  MachineImage,
} from './cloud-provider.js';

/**
 * Orchestrates provider operations against a stored credential: decrypts the
 * credential, builds the concrete {@link CloudProvider} via the injected
 * {@link ProviderFactory}, and runs the requested capability.
 */
export class ProviderConnectionService {
  constructor(
    private readonly credentials: CredentialService,
    private readonly factory: ProviderFactory,
  ) {}

  testConnection(credentialId: string): Promise<Result<ConnectionTestResult, ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.testConnection());
  }

  listRegions(credentialId: string): Promise<Result<Region[], ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.listRegions());
  }

  listShapes(credentialId: string): Promise<Result<Shape[], ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.listShapes());
  }

  listImages(credentialId: string): Promise<Result<MachineImage[], ProviderError>> {
    return this.withProvider(
      credentialId,
      (provider) =>
        provider.listImages?.() ??
        Promise.resolve(
          err(new ProviderError(`${provider.kind} does not support image discovery`)),
        ),
    );
  }

  listAvailabilityDomains(
    credentialId: string,
  ): Promise<Result<AvailabilityDomain[], ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.listAvailabilityDomains());
  }

  listInstances(credentialId: string): Promise<Result<CloudInstance[], ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.listInstances());
  }

  terminateInstance(
    credentialId: string,
    instanceId: string,
  ): Promise<Result<void, ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.terminateInstance(instanceId));
  }

  instanceAction(
    credentialId: string,
    instanceId: string,
    action: InstanceAction,
  ): Promise<Result<CloudInstance, ProviderError>> {
    return this.withProvider(credentialId, (provider) =>
      provider.instanceAction(instanceId, action),
    );
  }

  listResources(credentialId: string): Promise<Result<CloudResource[], ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.listResources());
  }

  getInstanceFirewall(
    credentialId: string,
    instanceId: string,
  ): Promise<Result<InstanceFirewall, ProviderError>> {
    return this.withProvider(
      credentialId,
      (provider) =>
        provider.getInstanceFirewall?.(instanceId) ??
        Promise.resolve(
          err(new ProviderError(`${provider.kind} does not support live firewall management`)),
        ),
    );
  }

  updateInstanceFirewall(
    credentialId: string,
    instanceId: string,
    rules: readonly LiveFirewallRule[],
  ): Promise<Result<InstanceFirewall, ProviderError>> {
    const validation = validateFirewallRules(rules);
    if (!validation.ok) return Promise.resolve(validation);
    return this.withProvider(
      credentialId,
      (provider) =>
        provider.updateInstanceFirewall?.(instanceId, validation.value) ??
        Promise.resolve(
          err(new ProviderError(`${provider.kind} does not support live firewall management`)),
        ),
    );
  }

  /** Resolve a provider from a credential id and run an operation against it. */
  private async withProvider<T>(
    credentialId: string,
    operation: (provider: CloudProvider) => Promise<Result<T, ProviderError>>,
  ): Promise<Result<T, ProviderError>> {
    const credential = await this.credentials.getDecrypted(credentialId);
    if (!credential.ok) {
      return err(
        new ProviderError('Could not load provider credential', { cause: credential.error }),
      );
    }

    const kind = credential.value.kind;
    if (!isProviderKind(kind)) {
      return err(new ProviderError(`"${kind}" is not a cloud provider`, { context: { kind } }));
    }

    const provider = this.factory.create(kind, credential.value.data);
    if (!provider.ok) return provider;

    return operation(provider.value);
  }
}

const CIDR =
  /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$|^[0-9a-f:]+\/(?:\d|[1-9]\d|1[01]\d|12[0-8])$/i;
export function validateFirewallRules(
  rules: readonly LiveFirewallRule[],
): Result<readonly LiveFirewallRule[], ProviderError> {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule.id || ids.has(rule.id))
      return err(new ProviderError('Firewall rules must have unique identifiers'));
    ids.add(rule.id);
    if (!isValidCidr(rule.cidr)) return err(new ProviderError(`Invalid CIDR: ${rule.cidr}`));
    if (rule.description.trim().length > 255)
      return err(new ProviderError('Firewall rule descriptions must be 255 characters or fewer'));
    if ((rule.portFrom === null) !== (rule.portTo === null))
      return err(new ProviderError('Both ends of a port range are required'));
    if (
      rule.portFrom !== null &&
      (!Number.isInteger(rule.portFrom) ||
        !Number.isInteger(rule.portTo) ||
        rule.portFrom < 1 ||
        (rule.portTo ?? 0) > 65_535 ||
        rule.portFrom > (rule.portTo ?? 0))
    )
      return err(new ProviderError('Firewall port range must be within 1–65535'));
  }
  return { ok: true, value: rules };
}

function isValidCidr(value: string): boolean {
  if (!CIDR.test(value)) return false;
  const slash = value.lastIndexOf('/');
  const address = value.slice(0, slash);
  if (address.includes(':')) {
    if ((address.match(/::/g) ?? []).length > 1) return false;
    const groups = address.split(':').filter(Boolean);
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
    return address.includes('::') ? groups.length < 8 : groups.length === 8;
  }
  return address.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}
