import { err, ProviderError, type Result } from '@cloudforge/shared';
import type {
  CloudProvider,
  ProviderCredentials,
  ProviderFactory,
  ProviderKind,
} from '@cloudforge/core';
import { OracleProvider } from './oracle/oracle-provider.js';

/** Provider kinds with a concrete implementation available today. */
const IMPLEMENTED: ReadonlySet<ProviderKind> = new Set(['oracle']);

/**
 * Default {@link ProviderFactory}. Registering a new provider is adding one
 * `case` here plus its implementation — the rest of the system is unchanged.
 */
export class DefaultProviderFactory implements ProviderFactory {
  supports(kind: ProviderKind): boolean {
    return IMPLEMENTED.has(kind);
  }

  create(
    kind: ProviderKind,
    credentials: ProviderCredentials,
  ): Result<CloudProvider, ProviderError> {
    switch (kind) {
      case 'oracle':
        return OracleProvider.fromCredentials(credentials);
      default:
        return err(
          new ProviderError(`Provider "${kind}" is not yet implemented`, { context: { kind } }),
        );
    }
  }
}
