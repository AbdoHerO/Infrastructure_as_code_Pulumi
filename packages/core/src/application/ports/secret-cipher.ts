import type { EncryptionError, Result } from '@cloudforge/shared';

/**
 * Port for symmetric encryption of secret material. The Infrastructure layer
 * implements this using the OS keychain (Electron `safeStorage`) when available,
 * falling back to an application-managed AES-GCM key otherwise.
 *
 * Implementations must never return plaintext as ciphertext.
 */
export interface SecretCipher {
  /** Encrypt UTF-8 plaintext, returning an opaque base64 ciphertext. */
  encrypt(plaintext: string): Result<string, EncryptionError>;

  /** Decrypt a base64 ciphertext produced by {@link encrypt}. */
  decrypt(ciphertext: string): Result<string, EncryptionError>;

  /** Whether encryption is backed by the OS keychain (vs. the fallback key). */
  readonly backedByOsKeychain: boolean;
}
