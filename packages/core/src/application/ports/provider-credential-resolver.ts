import type { InfrastructureError, Result } from '@cloudforge/shared';
import type { ProviderCredentials } from './provider-factory.js';

/**
 * Port that resolves the decrypted cloud-provider credentials a project's
 * infrastructure engine needs to authenticate against the provider (e.g. Oracle
 * Cloud). The concrete implementation lives in the composition root, where the
 * project→credential link and the secret cipher are available; the Application
 * layer depends only on this abstraction so it never touches decryption itself.
 */
export interface ProviderCredentialResolver {
  /**
   * The decrypted credentials for the provider linked to `projectId`, or an
   * {@link InfrastructureError} if no provider is linked or it cannot be loaded.
   */
  forProject(projectId: string): Promise<Result<ProviderCredentials, InfrastructureError>>;
}
