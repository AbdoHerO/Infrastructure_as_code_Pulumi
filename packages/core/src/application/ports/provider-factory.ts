import type { ProviderError, Result } from '@cloudforge/shared';
import type { ProviderKind } from '../../domain/provider/provider-kind.js';
import type { CloudProvider } from '../providers/cloud-provider.js';

/** Decrypted credential fields passed to a provider factory. */
export type ProviderCredentials = Readonly<Record<string, string>>;

/**
 * Port that constructs a concrete {@link CloudProvider} from a kind and its
 * decrypted credentials. Implemented in the `@cloudforge/providers` package;
 * this inversion keeps the Application layer free of provider SDKs.
 */
export interface ProviderFactory {
  /** Whether a provider implementation exists for the given kind. */
  supports(kind: ProviderKind): boolean;

  /** Instantiate a provider, or fail if the kind is unsupported. */
  create(
    kind: ProviderKind,
    credentials: ProviderCredentials,
  ): Result<CloudProvider, ProviderError>;
}
