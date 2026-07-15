import type { ProviderCredentials } from './provider-factory.js';
import type {
  ServiceProvider,
  ServiceProviderKind,
} from '../service-providers/service-provider.js';
import type { Result, ServiceProviderError } from '@cloudforge/shared';

export interface ServiceProviderFactory {
  create(
    kind: ServiceProviderKind,
    credentials: ProviderCredentials,
  ): Result<ServiceProvider, ServiceProviderError>;
}
