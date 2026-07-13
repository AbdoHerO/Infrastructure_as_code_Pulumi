/**
 * `@cloudforge/providers` — cloud provider plugins.
 *
 * Implements the `CloudProvider` contract from `@cloudforge/core`. Oracle Cloud
 * is provided first; new providers are added by implementing the interface and
 * registering them in the {@link DefaultProviderFactory}.
 */
export { DefaultProviderFactory } from './registry.js';
export { OracleProvider } from './oracle/oracle-provider.js';
export { signRequest, buildSigningString } from './oracle/oci-signer.js';
export type { SignableRequest, SignedHeaders } from './oracle/oci-signer.js';
