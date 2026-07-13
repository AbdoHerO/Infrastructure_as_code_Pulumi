import { err, ProviderError, type Result } from '@cloudforge/shared';
import { isProviderKind } from '../../domain/provider/provider-kind.js';
import type { ProviderFactory } from '../ports/provider-factory.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type {
  AvailabilityDomain,
  CloudProvider,
  ConnectionTestResult,
  Region,
  Shape,
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

  listAvailabilityDomains(
    credentialId: string,
  ): Promise<Result<AvailabilityDomain[], ProviderError>> {
    return this.withProvider(credentialId, (provider) => provider.listAvailabilityDomains());
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
