import { err, ServiceProviderError, type Result } from '@cloudforge/shared';
import type {
  ProviderCredentials,
  ServiceProvider,
  ServiceProviderFactory,
  ServiceProviderKind,
} from '@cloudforge/core';
import { CloudflareApiProvider } from './cloudflare/cloudflare-api-provider.js';

export class DefaultServiceProviderFactory implements ServiceProviderFactory {
  constructor(private readonly cloudflareApiBaseUrl: string) {}

  create(
    kind: ServiceProviderKind,
    credentials: ProviderCredentials,
  ): Result<ServiceProvider, ServiceProviderError> {
    if (kind !== 'cloudflare')
      return err(new ServiceProviderError(`Service provider "${kind}" is not implemented`));
    return CloudflareApiProvider.fromCredentials(credentials, this.cloudflareApiBaseUrl);
  }
}
