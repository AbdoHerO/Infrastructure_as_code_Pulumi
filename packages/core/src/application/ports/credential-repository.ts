import type { PersistenceError, Result } from '@cloudforge/shared';
import type { CredentialKind } from '../../domain/credential/credential-kind.js';
import type { CredentialId } from '../../domain/credential/credential.js';

/**
 * A persisted credential record. The `ciphertext` is the encrypted JSON blob of
 * the secret data — repositories store and return it opaque; only the
 * `CredentialService` (via the `SecretCipher`) ever decrypts it.
 */
export interface CredentialRecord {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly providerId: string | null;
  readonly ciphertext: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Persistence port for encrypted credentials. */
export interface CredentialRepository {
  findAll(): Promise<Result<CredentialRecord[], PersistenceError>>;
  findById(id: CredentialId): Promise<Result<CredentialRecord | null, PersistenceError>>;
  save(record: CredentialRecord): Promise<Result<void, PersistenceError>>;
  delete(id: CredentialId): Promise<Result<void, PersistenceError>>;
}
