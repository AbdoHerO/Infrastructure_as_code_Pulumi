import type { Result, ValidationError } from '@cloudforge/shared';

export type SshKeyAlgorithm = 'ed25519' | 'rsa';

export interface SshKeyMaterial {
  readonly algorithm: SshKeyAlgorithm;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** Node-specific key operations are implemented outside the core package. */
export interface SshKeyGenerator {
  generate(
    algorithm: SshKeyAlgorithm,
    passphrase?: string,
  ): Result<SshKeyMaterial, ValidationError>;
  inspect(privateKey: string, passphrase?: string): Result<SshKeyMaterial, ValidationError>;
}
