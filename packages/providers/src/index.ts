/**
 * `@cloudforge/providers` — cloud provider plugins.
 *
 * Implements the `CloudProvider` contract from `@cloudforge/core`. Oracle Cloud
 * is the complete reference implementation; AWS capabilities are introduced in
 * isolated increments through the same provider-independent interface.
 */
export { DefaultProviderFactory } from './registry.js';
export { OracleProvider } from './oracle/oracle-provider.js';
export { AwsProvider } from './aws/aws-provider.js';
export type { AwsClientSet } from './aws/aws-provider.js';
export { signRequest, buildSigningString } from './oracle/oci-signer.js';
export type { SignableRequest, SignedHeaders } from './oracle/oci-signer.js';
